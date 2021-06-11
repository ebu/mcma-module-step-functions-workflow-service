import { Context, ScheduledEvent } from "aws-lambda";
import * as AWSXRay from "aws-xray-sdk-core";
import { v4 as uuidv4 } from "uuid";

import { JobProperties, JobStatus, McmaTracker, ProblemDetail, WorkflowJob } from "@mcma/core";
import { AwsCloudWatchLoggerProvider } from "@mcma/aws-logger";
import { DynamoDbTableProvider } from "@mcma/aws-dynamodb";
import { getTableName, Query } from "@mcma/data";

import { WorkflowExecution } from "@local/common";
import { ProcessJobAssignmentHelper, WorkerRequest } from "@mcma/worker";
import { awsV4Auth } from "@mcma/aws-client";
import { AuthProvider, ResourceManagerProvider } from "@mcma/client";

const { LogGroupName, CloudWatchEventRule } = process.env;

const AWS = AWSXRay.captureAWS(require("aws-sdk"));

const authProvider = new AuthProvider().add(awsV4Auth(AWS));
const cloudWatchEvents = new AWS.CloudWatchEvents();
const loggerProvider = new AwsCloudWatchLoggerProvider("workflow-service-periodic-execution-checker", LogGroupName, new AWS.CloudWatchLogs());
const resourceManagerProvider = new ResourceManagerProvider(authProvider);
const stepFunctions = new AWS.StepFunctions();
const tableProvider = new DynamoDbTableProvider({}, new AWS.DynamoDB());

export async function handler(event: ScheduledEvent, context: Context) {
    const tracker = new McmaTracker({
        id: uuidv4(),
        label: "Periodic Execution Checker - " + new Date().toUTCString()
    });

    const logger = loggerProvider.get(context.awsRequestId, tracker);
    try {
        await cloudWatchEvents.disableRule({ Name: CloudWatchEventRule }).promise();

        const table = await tableProvider.get(getTableName());

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

            const execution = await stepFunctions.describeExecution({ executionArn: workflowExecution.executionArn }).promise();
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

                const stateMachine = await stepFunctions.describeStateMachineForExecution({ executionArn: workflowExecution.executionArn }).promise();
                logger.info(stateMachine);

                const executionHistoryParams: AWS.StepFunctions.Types.GetExecutionHistoryInput = {
                    executionArn: workflowExecution.executionArn,
                    maxResults: 1000,
                    includeExecutionData: true,
                    nextToken: undefined,
                };
                const historyEvents: AWS.StepFunctions.Types.HistoryEvent[] = [];
                do {
                    const executionHistory = await stepFunctions.getExecutionHistory(executionHistoryParams).promise();
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
                        if (workflowOutput?.output !== null && typeof workflowOutput?.output === "object") {
                            for (const key of Object.keys(workflowOutput?.output)) {
                                jobAssignmentHelper.jobOutput.set(key, workflowOutput[key]);
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
                logger.error(error.message);
                logger.error(error.toString());
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
            await cloudWatchEvents.enableRule({ Name: CloudWatchEventRule }).promise();
        }
    } catch (error) {
        logger.error(error?.toString());
        throw error;
    } finally {
        logger.functionEnd(context.awsRequestId);
        await loggerProvider.flush();
    }
}

function computeProgress(stateMachine: AWS.StepFunctions.DescribeStateMachineForExecutionOutput, historyEvents: AWS.StepFunctions.HistoryEvent[]) {
    const workflowDefinition = JSON.parse(stateMachine.definition);






    return 0;
}
