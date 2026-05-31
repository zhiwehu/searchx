import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowTask } from "../src/workflowQueue.js";

test("runWorkflowTask serializes concurrent work in submission order", async () => {
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];

  await Promise.all(
    [1, 2, 3].map((value) =>
      runWorkflowTask(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(value);
        active -= 1;
        return value;
      })
    )
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(order, [1, 2, 3]);
});
