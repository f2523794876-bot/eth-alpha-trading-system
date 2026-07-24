// V1.4C P0-1修复：通用的、可注入的分阶段生命周期编排——不属于任何具体业务组件，只负责按给定顺序启动一组
// {name,start,stop}阶段，任一阶段start()失败时按已成功启动的阶段逆序执行stop()回滚。回滚是尽力而为：单个阶段
// stop()报错会被记录（通过onStageStopError）但不会中断其余阶段的回滚，也不会替换最终对外抛出的原始启动错误。
// 正常关停复用同一个stopStagesInOrder()，保证"失败回滚"与"正常关停"遵循同一套逆序生命周期顺序。

export async function startStagesWithRollback(stages, { onStageStopError } = {}) {
  const started = [];
  try {
    for (const stage of stages) {
      await stage.start();
      started.push(stage);
    }
    return started;
  } catch (startError) {
    await stopStagesInOrder(started, { onStageStopError });
    throw startError;
  }
}

export async function stopStagesInOrder(stages, { onStageStopError } = {}) {
  for (const stage of [...stages].reverse()) {
    try {
      await stage.stop();
    } catch (stopError) {
      onStageStopError?.(stage, stopError);
    }
  }
}

// P0-1修复：共享资源（Postgres连接池）的关闭必须防止重复关闭——无论是"启动失败回滚后关闭"还是"正常关停时关闭"
// 都调用同一个closer，第二次及以后的调用直接是no-op，不会对pool.end()发起第二次调用。
export function createIdempotentCloser(closeFn) {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await closeFn();
  };
}
