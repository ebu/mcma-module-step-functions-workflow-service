import { ProviderCollection, WorkerRequest } from "@mcma/worker";
import { StepFunctions } from "aws-sdk";
import { JobStatus } from "@mcma/core";

export async function processNotification(providers: ProviderCollection, workerRequest: WorkerRequest, context: { awsRequestId: string, stepFunctions: StepFunctions }) {
    const notification = workerRequest.input.notification;
    const taskToken = workerRequest.input.taskToken;

    switch (notification.content.status) {
        case JobStatus.Completed: {
            await context.stepFunctions.sendTaskSuccess({
                taskToken: taskToken,
                output: JSON.stringify(notification.source)
            }).promise();
            break;
        }
        case JobStatus.Failed: {
            const error = "JobFailed";
            const cause = JSON.stringify(notification.content);

            await context.stepFunctions.sendTaskFailure({
                taskToken: taskToken,
                error: error,
                cause: cause
            }).promise();
            break;
        }
        case JobStatus.Canceled: {
            const error = "JobCanceled";
            const cause = JSON.stringify(notification.content);

            await context.stepFunctions.sendTaskFailure({
                taskToken: taskToken,
                error: error,
                cause: cause
            }).promise();
            break;
        }
    }
}
