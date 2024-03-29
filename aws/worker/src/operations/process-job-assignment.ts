import { v4 as uuidv4 } from "uuid";
import { CloudWatchEventsClient } from "@aws-sdk/client-cloudwatch-events";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

import { JobStatus, McmaException, NotificationEndpoint, ProblemDetail, WorkflowJob } from "@mcma/core";
import { ProcessJobAssignmentHelper, ProviderCollection, WorkerRequest } from "@mcma/worker";
import { DocumentDatabaseTable, getTableName, Query } from "@mcma/data";

import { Workflow, WorkflowExecution, enableEventRule } from "@local/common";

const { CLOUD_WATCH_EVENT_RULE } = process.env;

export async function processJobAssignment(providers: ProviderCollection, workerRequest: WorkerRequest, context: { awsRequestId: string, sfnClient: SFNClient, cloudWatchEventsClient: CloudWatchEventsClient }) {
    if (!workerRequest) {
        throw new McmaException("request must be provided");
    }
    if (!workerRequest.input) {
        throw new McmaException("request.input is required");
    }
    if (!workerRequest.input.jobAssignmentDatabaseId) {
        throw new McmaException("request.input does not specify a jobAssignmentDatabaseId");
    }

    const table = await providers.dbTableProvider.get(getTableName());
    const resourceManager = providers.resourceManagerProvider.get();
    const jobAssignmentHelper = new ProcessJobAssignmentHelper<WorkflowJob>(table, resourceManager, workerRequest);

    const logger = jobAssignmentHelper.logger;

    const mutex = table.createMutex({
        name: jobAssignmentHelper.jobAssignmentDatabaseId,
        holder: context.awsRequestId,
        logger,
    });

    await mutex.lock();
    try {
        workerRequest.logger?.info("Initializing job helper...");

        const { Running } = JobStatus;
        await jobAssignmentHelper.initialize(Running);

        workerRequest.logger?.info("Validating job...");

        if (jobAssignmentHelper.job["@type"] !== "WorkflowJob") {
            throw new McmaException("Job has type '" + jobAssignmentHelper.job["@type"] + "', which does not match expected job type 'WorkflowJob'.");
        }

        const selectedWorkflow = await getWorkflowByName(table, jobAssignmentHelper.profile.name);

        jobAssignmentHelper.validateJob();

        workerRequest.logger?.info("Found handler for job profile '" + jobAssignmentHelper.profile.name + "'");

        await executeWorkflow(providers, jobAssignmentHelper, context, selectedWorkflow);

        workerRequest.logger?.info("Handler for job profile '" + jobAssignmentHelper.profile.name + "' completed");
    } catch (e) {
        workerRequest.logger?.error(e.message);
        workerRequest.logger?.error(e.toString());
        try {
            await jobAssignmentHelper.fail(new ProblemDetail({
                type: "uri://mcma.ebu.ch/rfc7807/generic-job-failure",
                title: "Generic job failure",
                detail: e.message
            }));
        } catch (inner) {
            workerRequest.logger?.error(inner.toString());
        }
    } finally {
        await mutex.unlock();
    }
}

async function getWorkflowByName(table: DocumentDatabaseTable, workflowName: string): Promise<Workflow> {
    const workflows = await getWorkflows(table);

    const selectedWorkflow = workflows.find(wf => wf.name === workflowName);
    if (!selectedWorkflow) {
        throw new McmaException(`JobProfile '${workflowName}' is not supported.`);
    }

    return selectedWorkflow;
}

async function getWorkflows(table: DocumentDatabaseTable): Promise<Workflow[]> {
    const workflows: Workflow[] = [];

    const queryParams: Query<Workflow> = {
        path: "/workflows",
        pageStartToken: undefined
    };
    do {
        const result = await table.query(queryParams);
        workflows.push(...result.results);
        queryParams.pageStartToken = result.nextPageStartToken;
    } while (queryParams.pageStartToken);

    return workflows;
}

async function executeWorkflow(providers: ProviderCollection, jobAssignmentHelper: ProcessJobAssignmentHelper<WorkflowJob>, context: { awsRequestId: string,  sfnClient: SFNClient, cloudWatchEventsClient: CloudWatchEventsClient }, workflow: Workflow) {
    const logger = jobAssignmentHelper.logger;

    const workflowInput = {
        input: jobAssignmentHelper.jobInput,
        notificationEndpoint: new NotificationEndpoint({
            httpEndpoint: jobAssignmentHelper.jobAssignment.id + "/notifications"
        }),
        tracker: jobAssignmentHelper.jobAssignment.tracker
    };

    logger.info("Starting execution of workflow '" + workflow.name + "' with input:");
    logger.info(workflowInput);
    const data = await context.sfnClient.send(new StartExecutionCommand({
        input: JSON.stringify(workflowInput),
        stateMachineArn: workflow.stateMachineArn
    }));

    const workflowExecutionId = "/workflow-executions/" + uuidv4();

    await jobAssignmentHelper.dbTable.put<WorkflowExecution>(workflowExecutionId, {
        id: workflowExecutionId,
        executionArn: data.executionArn,
        workerRequest: {
            operationName: jobAssignmentHelper.workerRequest.operationName,
            input: jobAssignmentHelper.workerRequest.input,
            tracker: jobAssignmentHelper.workerRequest.tracker,
        }
    });

    await enableEventRule(CLOUD_WATCH_EVENT_RULE, jobAssignmentHelper.dbTable, context.cloudWatchEventsClient, context.awsRequestId, logger);

    jobAssignmentHelper.jobOutput.executionArn = data.executionArn;
    await jobAssignmentHelper.updateJobAssignmentOutput();
}
