import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkerClient } from './workers/workerClient';
import type { WorkbenchState } from './state/state';
import type { ComputeMode, ImportBatch, PipelineProgress, Adjudication, WindowAnalysis } from './core/types';
import type { ImportFileInput } from './core/engine';
import { INCREMENTAL_THRESHOLD } from './core/engine';
import { OverviewPage } from './pages/OverviewPage';
import { ImportPage } from './pages/ImportPage';
import { SnapshotsPage } from './pages/SnapshotsPage';
import { AdjudicationPage } from './pages/AdjudicationPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { PipelinePage } from './pages/PipelinePage';
import { WindowsPage } from './pages/WindowsPage';

type NavKey = 'overview' | 'import' | 'snapshots' | 'adjudication' | 'projects' | 'windows' | 'pipeline';

const NAV: { key: NavKey; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'import', label: '快照导入' },
  { key: 'snapshots', label: '快照与证据' },
  { key: 'adjudication', label: '关系裁决' },
  { key: 'projects', label: '项目发布' },
  { key: 'windows', label: '投标窗口' },
  { key: 'pipeline', label: '计算流水线' },
];

export default function App() {
  const clientRef = useRef<WorkerClient | null>(null);
  if (!clientRef.current) clientRef.current = new WorkerClient();
  const client = clientRef.current;

  const [nav, setNav] = useState<NavKey>('overview');
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' | 'success' } | null>(null);

  const showToast = useCallback((text: string, kind: 'info' | 'error' | 'success' = 'info') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const refresh = useCallback(async () => {
    const next = (await client.call('getState', undefined)) as WorkbenchState;
    setState(next);
  }, [client]);

  useEffect(() => {
    const off = client.onProgress(setProgress);
    refresh().catch((e) => showToast(e.message, 'error'));
    return () => { off(); };
  }, [client, refresh, showToast]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await fn();
        await refresh();
        if (success) showToast(success, 'success');
        return result;
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [refresh, showToast],
  );

  const handleImport = (label: string, files: ImportFileInput[]) =>
    run(() => client.call('importBatch', { label, files }) as Promise<ImportBatch>, '批次导入完成');

  const handleAdjudicate = async (input: {
    edgeId: string;
    decision: Adjudication['decision'];
    note: string;
    reviewer: string;
    appliedFactIds: string[];
  }): Promise<void> => {
    await run(() => client.call('adjudicate', input), '裁决已保存');
  };

  const handleRecompute = async (mode: ComputeMode | 'auto'): Promise<void> => {
    await run(() => client.call('recompute', { mode }), `重算与发布完成（${mode}）`);
  };

  const handlePublishWindows = async (
    strategy: 'materialized' | 'on_demand',
    calendarCutoffAt: number | null,
  ): Promise<WindowAnalysis | undefined> =>
    run(
      () => client.call('publishWindows', { strategy, calendarCutoffAt }) as Promise<WindowAnalysis>,
      `窗口分析发布完成（${strategy === 'materialized' ? '物化区间' : '即时推演'}）`,
    );

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>采购归档证据图工作台</h1>
        <p className="subtitle">本地 · 离线 · 可复算</p>
        {NAV.map((n) => (
          <button key={n.key} className={`nav-btn ${nav === n.key ? 'active' : ''}`} onClick={() => setNav(n.key)}>
            {n.label}
          </button>
        ))}
        <div className="footer">
          React + TypeScript<br />IndexedDB + WebWorker<br />所有数据不离开浏览器
        </div>
      </aside>

      <main className="main">
        {nav === 'overview' && <OverviewPage state={state} />}
        {nav === 'import' && (
          <ImportPage busy={busy} progress={progress} onImport={handleImport} batches={state?.batches ?? []} />
        )}
        {nav === 'snapshots' && state && <SnapshotsPage snapshots={state.snapshots} facts={state.facts} />}
        {nav === 'adjudication' && state && (
          <AdjudicationPage
            edges={state.edges}
            snapshots={state.snapshots}
            facts={state.facts}
            adjudications={state.adjudications}
            withdrawn={state.withdrawn}
            busy={busy}
            onAdjudicate={handleAdjudicate}
          />
        )}
        {nav === 'projects' && state && (
          <ProjectsPage publications={state.publications} snapshots={state.snapshots} facts={state.facts} />
        )}
        {nav === 'windows' && state && (
          <WindowsPage
            busy={busy}
            analyses={state.windowAnalyses}
            calendars={state.calendars}
            snapshots={state.snapshots}
            onPublish={handlePublishWindows}
            onCheck={() => run(() => client.call('checkWindowStrategies', undefined) as Promise<any>)}
            onDiff={(beforeVersion, afterVersion) =>
              run(() => client.call('diffWindowVersions', { beforeVersion, afterVersion }) as Promise<any>)
            }
          />
        )}
        {nav === 'pipeline' && state && (
          <PipelinePage
            busy={busy}
            progress={progress}
            onRecompute={handleRecompute}
            onCheck={() => run(() => client.call('checkConsistency', undefined) as Promise<any>)}
            onReplay={() => run(() => client.call('replay', undefined) as Promise<any>)}
            onClear={() => run(async () => { await client.call('clearAll', undefined); }, '本地数据已清空')}
            publications={state.publications}
            threshold={INCREMENTAL_THRESHOLD}
            snapshotCount={state.snapshots.length}
          />
        )}
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
