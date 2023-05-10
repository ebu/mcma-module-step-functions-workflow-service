import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from "@aws-sdk/client-sfn";

import { ProviderCollection, WorkerRequest } from "@mcma/worker";
import { JobStatus } from "@mcma/core";

export async function processNotification(providers: ProviderCollection, workerRequest: WorkerRequest, context: { awsRequestId: string, sfnClient: SFNClient }) {
    const notification = workerRequest.input.notification;
    const taskToken = workerRequest.input.taskToken;

    switch (notification.content.status) {
        case JobStatus.Completed: {
            await context.sfnClient.send(new SendTaskSuccessCommand({
                taskToken: taskToken,
                output: JSON.stringify(notification.source)
            }));
            break;
        }
        case JobStatus.Failed: {
            const error = "JobFailed";
            const cause = JSON.stringify(notification.content);

            await context.sfnClient.send(new SendTaskFailureCommand({
                taskToken: taskToken,
                error: error,
                cause: cause
            }));
            break;
        }
        case JobStatus.Canceled: {
            const error = "JobCanceled";
            const cause = JSON.stringify(notification.content);

            await context.sfnClient.send(new SendTaskFailureCommand({
                taskToken: taskToken,
                error: error,
                cause: cause
            }));
            break;
        }
    }
}
