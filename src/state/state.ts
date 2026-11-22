/** UI 使用的聚合状态结构，与 worker getState 返回保持一致 */
import type {
  Adjudication,
  Fact,
  ImportBatch,
  PipelineProgress,
  Publication,
  RelationEdge,
  Snapshot,
  WindowAnalysis,
  WithdrawnEdgeRecord,
} from '../core/types';
import type { EngineMeta } from '../core/engine';
import type { CalendarVersionRecord } from '../core/calendar';

export interface WorkbenchState {
  snapshots: Snapshot[];
  batches: ImportBatch[];
  facts: Fact[];
  edges: RelationEdge[];
  adjudications: Adjudication[];
  withdrawn: WithdrawnEdgeRecord[];
  publications: Publication[];
  latestPublication: Publication | null;
  meta: EngineMeta | null;
  versions: {
    PARSER_VERSION: string;
    EXTRACTOR_VERSION: string;
    EVALUATOR_VERSION: string;
    TIME_EXTRACTOR_VERSION: string;
    WINDOW_ENGINE_VERSION: string;
  };
  calendars: CalendarVersionRecord[];
  windowAnalyses: WindowAnalysis[];
  latestWindowAnalysis: WindowAnalysis | null;
}

export type { PipelineProgress };
