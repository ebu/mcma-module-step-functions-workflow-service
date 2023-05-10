import { Context, ScheduledEvent } from "aws-lambda";
import * as AWSXRay from "aws-xray-sdk-core";
import { v4 as uuidv4 } from "uuid";
import { CloudWatchEventsClient } from "@aws-sdk/client-cloudwatch-events";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DescribeExecutionCommand,
    DescribeStateMachineForExecutionCommand, DescribeStateMachineForExecutionCommandOutput,
    GetExecutionHistoryCommand,
    GetExecutionHistoryCommandInput,
    HistoryEvent,
    SFNClient
} from "@aws-sdk/client-sfn";

import { JobProperties, JobStatus, McmaTracker, ProblemDetail, WorkflowJob } from "@mcma/core";
import { AwsCloudWatchLoggerProvider, getLogGroupName } from "@mcma/aws-logger";
import { DynamoDbTableProvider } from "@mcma/aws-dynamodb";
import { getTableName, Query } from "@mcma/data";

import { disableEventRule, enableEventRule, WorkflowExecution } from "@local/common";
import { ProcessJobAssignmentHelper, WorkerRequest } from "@mcma/worker";
import { awsV4Auth } from "@mcma/aws-client";
import { AuthProvider, ResourceManagerProvider } from "@mcma/client";

const { CLOUD_WATCH_EVENT_RULE } = process.env;

const cloudWatchLogsClient = AWSXRay.captureAWSv3Client(new CloudWatchLogsClient({}));
const cloudWatchEventsClient = AWSXRay.captureAWSv3Client(new CloudWatchEventsClient({}));
const dynamoDBClient = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const sfnClient = AWSXRay.captureAWSv3Client(new SFNClient({}));

const authProvider = new AuthProvider().add(awsV4Auth());
const loggerProvider = new AwsCloudWatchLoggerProvider("workflow-service-eventbridge-handler", getLogGroupName(), cloudWatchLogsClient);
const resourceManagerProvider = new ResourceManagerProvider(authProvider);
const tableProvider = new DynamoDbTableProvider({}, dynamoDBClient);

export async function handler(event: ScheduledEvent, context: Context) {
    const tracker = new McmaTracker({
        id: uuidv4(),
        label: "Periodic Execution Checker - " + new Date().toUTCString()
    });
    const logger = loggerProvider.get(context.awsRequestId, tracker);
    logger.functionStart(context.awsRequestId);
    logger.debug(event);
    logger.debug(context);

    try {
        const table = await tableProvider.get(getTableName());
        const mutex = table.createMutex({ name: "workflow-service-eventbridge-handler", holder: context.awsRequestId, logger });
        if (!await mutex.tryLock()) {
            return;
        }
        try {
            await disableEventRule(CLOUD_WATCH_EVENT_RULE, table, cloudWatchEventsClient, context.awsRequestId, logger);

            const queryParameters: Query<WorkflowExecution> = {
                path: "/workflow-executions",
                pageStartToken: undefined
            };
            const workflowExecutions = [];

            do {
                const queryResults = await table.query<WorkflowExecution>(queryParameters);
                workflowExecutions.push(...queryResults.results);
                queryParameters.pageStartToken = queryResults.nextPageStartToken;
            } while (queryParameters.pageStartToken);

            logger.info(`Found ${workflowExecutions.length} active executions`);

            let activeExecutions = 0;

            for (const workflowExecution of workflowExecutions) {
                logger.info("Processing execution for job assignment " + workflowExecution.workerRequest.input?.jobAssignmentDatabaseId);
                logger.info(workflowExecution);

                const execution = await sfnClient.send(new DescribeExecutionCommand({ executionArn: workflowExecution.executionArn }));
                logger.info(execution);

                const workerRequest = new WorkerRequest(workflowExecution.workerRequest, logger);
                const resourceManager = resourceManagerProvider.get();
                const jobAssignmentHelper = new ProcessJobAssignmentHelper<WorkflowJob>(table, resourceManager, workerRequest);

                const mutex = table.createMutex({
                    name: workerRequest.input.jobAssignmentDatabaseId,
                    holder: context.awsRequestId
                });
                await mutex.lock();
                try {
                    await jobAssignmentHelper.initialize();

                    if (jobAssignmentHelper.jobAssignment.status === JobStatus.Completed ||
                        jobAssignmentHelper.jobAssignment.status === JobStatus.Failed ||
                        jobAssignmentHelper.jobAssignment.status === JobStatus.Canceled) {
                        logger.warn("Ignoring status update as job already reached final state");
                        await table.delete(workflowExecution.id);
                        continue;
                    }

                    const stateMachine = await sfnClient.send(new DescribeStateMachineForExecutionCommand({ executionArn: workflowExecution.executionArn }));
                    logger.info(stateMachine);

                    const executionHistoryParams: GetExecutionHistoryCommandInput = {
                        executionArn: workflowExecution.executionArn,
                        maxResults: 1000,
                        includeExecutionData: true,
                        nextToken: undefined,
                    };
                    const historyEvents: HistoryEvent[] = [];
                    do {
                        const executionHistory = await sfnClient.send(new GetExecutionHistoryCommand(executionHistoryParams));
                        historyEvents.push(...executionHistory.events);
                        executionHistoryParams.nextToken = executionHistory.nextToken;
                    } while (executionHistoryParams.nextToken);

                    logger.info(historyEvents);

                    let workflowOutput: { [key: string]: any } | undefined;

                    if (execution.output) {
                        try {
                            const output = JSON.parse(execution.output);
                            if (typeof output === "object") {
                                workflowOutput = output;
                            }
                        } catch (error) {
                            logger.error("Failed to parse workflow output");
                            logger.error(error);
                        }
                    }

                    let progress = computeProgress(stateMachine, historyEvents);

                    switch (execution.status) {
                        case "RUNNING":
                            activeExecutions++;
                            await jobAssignmentHelper.updateJobAssignment(jobAssigment => jobAssigment.progress = progress, true);
                            break;
                        case "SUCCEEDED":
                            await table.delete(workflowExecution.id);
                            if (workflowOutput.output && typeof workflowOutput.output === "object") {
                                for (const key of Object.keys(workflowOutput?.output)) {
                                    jobAssignmentHelper.jobOutput[key] = workflowOutput.output[key];
                                }
                            }
                            await jobAssignmentHelper.complete();
                            break;
                        case "FAILED":
                            await table.delete(workflowExecution.id);

                            let error = new ProblemDetail({
                                type: "uri://mcma.ebu.ch/rfc7807/step-functions-workflow-service/generic-workflow-failure",
                                title: "Workflow failure",
                                detail: "Unknown reason"
                            });

                            const historyEvent = historyEvents.find(e => e.type === "ExecutionFailed");

                            switch (historyEvent?.executionFailedEventDetails?.error) {
                                case "Error": {
                                    let detail;

                                    try {
                                        detail = JSON.parse(historyEvent?.executionFailedEventDetails?.cause).errorMessage ?? historyEvent?.executionFailedEventDetails?.cause ?? "Unknown error occurred";
                                    } catch (e) {
                                        detail = historyEvent?.executionFailedEventDetails?.cause ?? "Unknown error occurred";
                                    }

                                    error = new ProblemDetail({
                                        type: "uri://mcma.ebu.ch/rfc7807/step-functions-workflow-service/step-failure",
                                        title: "Error in execution of workflow step",
                                        detail
                                    });
                                    break;
                                }
                                case "JobFailed": {
                                    const job: JobProperties = JSON.parse(historyEvent?.executionFailedEventDetails?.cause);

                                    error = new ProblemDetail({
                                        type: "uri://mcma.ebu.ch/rfc7807/step-functions-workflow-service/job-failure",
                                        title: "Execution of Job Failed",
                                        detail: `Job '${job.id} failed due to error '${job.error?.title}`,
                                        job: job,
                                    });
                                    break;
                                }
                                case "JobCanceled": {
                                    const job: JobProperties = JSON.parse(historyEvent?.executionFailedEventDetails?.cause);

                                    error = new ProblemDetail({
                                        type: "uri://mcma.ebu.ch/rfc7807/step-functions-workflow-service/job-failure",
                                        title: "Execution of Job Canceled",
                                        detail: `Job '${job.id} was canceled`,
                                        job: job
                                    });
                                    break;
                                }
                                case "States.Timeout": {
                                    error = new ProblemDetail({
                                        type: "uri://mcma.ebu.ch/rfc7807/step-functions-workflow-service/job-execution-timeout",
                                        title: "Execution of Job Timed out"
                                    });
                                    break;
                                }
                            }
                            await jobAssignmentHelper.fail(error);
                            break;
                        case "TIMED_OUT":
                            await table.delete(workflowExecution.id);
                            await jobAssignmentHelper.fail(new ProblemDetail({
                                type: "uri://mcma.ebu.ch/rfc7807/step-functions-workflow-service/job-execution-timeout",
                                title: "Execution of a job timed out"
                            }));
                            break;
                        case "ABORTED":
                            await table.delete(workflowExecution.id);
                            await jobAssignmentHelper.cancel();
                            break;
                    }
                } catch (error) {
                    logger.error(error);
                    try {
                        await jobAssignmentHelper.fail(new ProblemDetail({
                            type: "uri://mcma.ebu.ch/rfc7807/step-functions-workflow-service/generic-error",
                            title: "Generic Error",
                            detail: "Unexpected error occurred: " + error.message,
                            stacktrace: error.stacktrace,
                        }));
                    } catch (inner) {
                        logger.error(inner.toString());
                    }
                } finally {
                    await mutex.unlock();
                }
            }

            if (activeExecutions) {
                logger.info(`There are ${activeExecutions} active executions remaining`);
                await enableEventRule(CLOUD_WATCH_EVENT_RULE, table, cloudWatchEventsClient, context.awsRequestId, logger);
            }
        } finally {
            await mutex.unlock();
        }
    } catch (error) {
        logger.error(error);
        throw error;
    } finally {
        logger.functionEnd(context.awsRequestId);
        await loggerProvider.flush();
    }
}

function computeProgress(stateMachine: DescribeStateMachineForExecutionCommandOutput, historyEvents: HistoryEvent[]) {
    const workflowDefinition = JSON.parse(stateMachine.definition);


    return 0;
}
