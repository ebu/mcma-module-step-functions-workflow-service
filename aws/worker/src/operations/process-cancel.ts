import { SFNClient, StopExecutionCommand} from "@aws-sdk/client-sfn";

import { ProcessJobAssignmentHelper, ProviderCollection, WorkerRequest } from "@mcma/worker";
import { getTableName } from "@mcma/data";
import { JobStatus, ProblemDetail, WorkflowJob } from "@mcma/core";

export async function processCancel(providers: ProviderCollection, workerRequest: WorkerRequest, context: { awsRequestId: string, sfnClient: SFNClient }) {
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
        await jobAssignmentHelper.initialize();

        if (jobAssignmentHelper.jobAssignment.status === JobStatus.Completed ||
            jobAssignmentHelper.jobAssignment.status === JobStatus.Failed ||
            jobAssignmentHelper.jobAssignment.status === JobStatus.Canceled) {
            return;
        }

        await context.sfnClient.send(new StopExecutionCommand({
            executionArn: jobAssignmentHelper.jobOutput.executionArn
        }));

        await jobAssignmentHelper.cancel();
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
            workerRequest.logger?.error(inner.toString());
        }
    } finally {
        await mutex.unlock();
    }
}
