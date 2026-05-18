import { fork, type ChildProcess } from 'node:child_process';

import { ulid } from 'ulid';

import { elapsedUs } from '../../timing.js';
import type {
  AsyncDetector,
  DetectionEnrichment,
  DetectorInput,
  EnrichmentSink,
  RpcId,
} from '../types.js';
import type { WorkerJobRequest, WorkerJobResponse } from './worker.js';

// Razon por la que un job NER se descarta. Exportado para que events.ts tipe
// la variante proxy.ner_dropped sin duplicar el literal (paralelo a
// SocketDropReason desde socket.js).
export type NerDropReason = 'queue_full' | 'worker_dead';

export type OnNerDrop = (
  reason: NerDropReason,
  jobId: string | undefined,
  rpcId: RpcId | undefined,
) => void;

export interface AsyncDetectorNerDeps {
  workerScript: string;
  enrichmentSink: EnrichmentSink;
  onDrop: OnNerDrop;
  // Inyectable para test (default node:child_process.fork). El test pasa un
  // fake controlable y evita fork real (251ms cold start + cache del modelo).
  forkImpl?: (modulePath: string) => ChildProcess;
}

const QUEUE_MAX = 256;

interface QueuedJob {
  request: WorkerJobRequest;
  // Capturado al entrar enqueue(); base de overheadUs (decision 5: total
  // off-path enqueue -> entrega al sink, medido con elapsedUs igual que el
  // path sincrono).
  t0Ns: bigint;
}

export class AsyncDetectorNer implements AsyncDetector {
  private readonly queue: QueuedJob[] = [];
  private readonly child: ChildProcess;
  private readonly enrichmentSink: EnrichmentSink;
  private readonly onDrop: OnNerDrop;
  private workerReady = false;
  private inFlight: QueuedJob | undefined;
  // PROVISIONAL: error recovery pendiente decision 7. Minimo defensivo: si el
  // worker muere, enqueue pasa a no-op silencioso (no crashea el proxy). NO
  // hay telemetria de crash ni restart aqui -- eso es la decision 7.
  private alive = true;

  constructor(deps: AsyncDetectorNerDeps) {
    this.enrichmentSink = deps.enrichmentSink;
    this.onDrop = deps.onDrop;
    const forkImpl = deps.forkImpl ?? fork;
    this.child = forkImpl(deps.workerScript);
    this.child.on('message', (msg: WorkerJobResponse) => {
      this.handleMessage(msg);
    });
    this.child.on('exit', () => {
      this.alive = false;
    });
    this.child.on('error', () => {
      this.alive = false;
    });
  }

  enqueue(input: DetectorInput, rpcId: RpcId): void {
    if (!this.alive) return;
    if (this.queue.length >= QUEUE_MAX) {
      // drop-newest (decision 4b): la cola llego a 256 -> el worker no da
      // abasto. El job entrante se descarta; gap en el JSONL correlaciona
      // con la saturacion (honesto con el lector).
      this.onDrop('queue_full', undefined, rpcId);
      return;
    }
    const jobId = ulid();
    const job: QueuedJob = {
      t0Ns: process.hrtime.bigint(),
      request: {
        kind: 'infer',
        jobId,
        paramsJson: input.paramsJson,
        rpcId,
        session: input.envelope.sessionId,
        direction: input.envelope.direction,
      },
    };
    // Lifecycle (decision 6-A): enqueue antes de 'ready' acumula en cola; al
    // recibir 'ready' se drena. El AsyncDetectorNer se construye eager en
    // main.ts despues del spawn del MCP child, asi que el primer burst de
    // frames (initialize/tools/list) normalmente llega antes de 'ready' (el
    // spawn+init del MCP suele tardar <100ms vs cold start NER ~251ms, pero
    // el timing relativo no esta medido): se acumula y se enriquece tras el
    // cold start. Registrar el primer
    // burst importa mas que evitar ese overheadUs alto (auditoria: registrar
    // generosamente). El terminate en shutdown sigue pendiente: decision 7.
    if (this.workerReady && this.inFlight === undefined) {
      this.dispatch(job);
    } else {
      this.queue.push(job);
    }
  }

  private dispatch(job: QueuedJob): void {
    this.inFlight = job;
    this.child.send(job.request);
  }

  private drain(): void {
    if (this.inFlight !== undefined) return;
    const next = this.queue.shift();
    if (next !== undefined) this.dispatch(next);
  }

  private handleMessage(msg: WorkerJobResponse): void {
    if (msg.kind === 'ready') {
      this.workerReady = true;
      this.drain();
      return;
    }
    const completed = this.inFlight;
    this.inFlight = undefined;
    if (msg.kind === 'result' && completed !== undefined) {
      const enrichment: DetectionEnrichment = {
        rpcId: msg.rpcId,
        session: msg.session,
        direction: msg.direction,
        detection: msg.detection,
        overheadUs: elapsedUs(completed.t0Ns),
      };
      this.enrichmentSink(enrichment);
    }
    // 'skip' y 'error' no invocan al sink (no hay enrichment). 'error' es
    // job-level: el worker sigue vivo, solo se drena el siguiente.
    this.drain();
  }
}
