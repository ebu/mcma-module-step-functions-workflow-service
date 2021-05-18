import { WorkerRequestProperties } from "@mcma/worker-invoker";

export interface WorkflowExecution {
    id: string
    executionArn: string,
    workerRequest: WorkerRequestProperties,
}
