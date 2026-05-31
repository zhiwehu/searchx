type WorkflowTask<T> = () => Promise<T>;

let tail: Promise<void> = Promise.resolve();

export function runWorkflowTask<T>(task: WorkflowTask<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
