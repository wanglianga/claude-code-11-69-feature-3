/**
 * 流水线 WebWorker：所有重计算（解析、提取、求值、发布、复跑）
 * 都在 worker 线程完成，主线程 UI 不阻塞。
 *
 * 协议：
 *  主线程 → worker：{ reqId, type, payload }
 *  worker → 主线程：{ reqId, type: 'result'|'error', payload }
 *  worker → 主线程：{ type: 'progress', payload: PipelineProgress }
 */
import { IndexedDbRepository } from '../core/repository';
import { WorkbenchEngine, type ImportFileInput, type WindowPublishOptions } from '../core/engine';
import type { PipelineProgress } from '../core/types';

export type WorkerRequest =
  | { reqId: string; type: 'importBatch'; payload: { label: string; files: ImportFileInput[] } }
  | { reqId: string; type: 'adjudicate'; payload: Parameters<WorkbenchEngine['adjudicate']>[0] }
  | { reqId: string; type: 'recompute'; payload: { mode: 'full' | 'incremental' | 'auto' } }
  | { reqId: string; type: 'checkConsistency'; payload: undefined }
  | { reqId: string; type: 'replay'; payload: undefined }
  | { reqId: string; type: 'getState'; payload: undefined }
  | { reqId: string; type: 'clearAll'; payload: undefined }
  | { reqId: string; type: 'publishWindows'; payload: WindowPublishOptions }
  | { reqId: string; type: 'checkWindowStrategies'; payload: undefined }
  | { reqId: string; type: 'diffWindowVersions'; payload: { beforeVersion: number; afterVersion: number } };

export type WorkerResponse =
  | { reqId: string; type: 'result'; payload: unknown }
  | { reqId: string; type: 'error'; payload: string }
  | { type: 'progress'; payload: PipelineProgress };

const repo = new IndexedDbRepository();
const engine = new WorkbenchEngine(repo, (p) => {
  const msg: WorkerResponse = { type: 'progress', payload: p };
  (self as unknown as Worker).postMessage(msg);
});

async function handle(req: WorkerRequest): Promise<unknown> {
  switch (req.type) {
    case 'importBatch':
      return engine.importBatch(req.payload.label, req.payload.files);
    case 'adjudicate':
      return engine.adjudicate(req.payload);
    case 'recompute':
      return engine.recomputeAndPublish(req.payload.mode);
    case 'checkConsistency':
      return engine.checkConsistency();
    case 'replay':
      return engine.replay();
    case 'getState':
      return {
        snapshots: await repo.getAllSnapshots(),
        batches: await repo.getAllBatches(),
        facts: await repo.getAllFacts(),
        edges: await repo.getAllEdges(),
        adjudications: await repo.getAllAdjudications(),
        withdrawn: await repo.getAllWithdrawn(),
        publications: await repo.getAllPublications(),
        latestPublication: await repo.getLatestPublication(),
        meta: await repo.getMeta(),
        versions: engine.versions(),
        calendars: (await engine.loadCalendarRegistry()).allVersions(),
        windowAnalyses: await repo.getAllWindowAnalyses(),
        latestWindowAnalysis: await repo.getLatestWindowAnalysis(),
      };
    case 'publishWindows':
      return engine.publishWindows(req.payload);
    case 'checkWindowStrategies':
      return engine.checkWindowStrategies();
    case 'diffWindowVersions':
      return engine.diffWindowVersions(req.payload.beforeVersion, req.payload.afterVersion);
    case 'clearAll':
      await repo.clearAll();
      return { cleared: true };
    default: {
      const exhaustive: never = req;
      throw new Error(`未知请求：${JSON.stringify(exhaustive)}`);
    }
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    const payload = await handle(req);
    const res: WorkerResponse = { reqId: req.reqId, type: 'result', payload };
    (self as unknown as Worker).postMessage(res);
  } catch (err) {
    const res: WorkerResponse = {
      reqId: req.reqId,
      type: 'error',
      payload: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(res);
  }
};
