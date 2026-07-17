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
import type { WorkerJobRequest, WorkerJobResponse } from './worker-pure.js';

// Razon por la que un job NER no produjo enrichment. Exportado para que
// events.ts tipe la variante proxy.ner_dropped sin duplicar el literal.
// 'error' es un fallo de inferencia job-level (el worker sigue vivo);
// 'queue_full'/'worker_dead' son descartes que ni llegan a inferir.
export type NerDropReason = 'queue_full' | 'worker_dead' | 'error';

export type OnNerDrop = (
  reason: NerDropReason,
  jobId: string | undefined,
  rpcId: RpcId | undefined,
) => void;

export interface AsyncDetectorNerDeps {
  workerScript: string;
  enrichmentSink: EnrichmentSink;
  onDrop: OnNerDrop;
  // Invocado una vez cuando el worker muere (exit o error). El caller emite
  // proxy.ner_worker_died. cause distingue salida limpia de error de fork.
  onWorkerDied: (cause: 'exit' | 'error', pendingDropped: number) => void;
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
  private readonly onWorkerDied: AsyncDetectorNerDeps['onWorkerDied'];
  private workerReady = false;
  private inFlight: QueuedJob | undefined;
  // Decision 7 (cerrada): si el worker muere, degradar sin reintentar. enqueue
  // pasa a no-op silencioso (alive=false), se drena la cola con onDrop
  // 'worker_dead' y se emite proxy.ner_worker_died via onWorkerDied. NO restart
  // automatico: el NER es off-path severidad low, un worker muerto degrada PII
  // pero no rompe proxy ni auditoria; restart se anadira con datos de
  // dogfooding si los justifican (Principio 6).
  private alive = true;

  constructor(deps: AsyncDetectorNerDeps) {
    this.enrichmentSink = deps.enrichmentSink;
    this.onDrop = deps.onDrop;
    this.onWorkerDied = deps.onWorkerDied;
    const forkImpl = deps.forkImpl ?? fork;
    this.child = forkImpl(deps.workerScript);
    this.child.on('message', (msg: WorkerJobResponse) => {
      this.handleMessage(msg);
    });
    this.child.on('exit', () => {
      this.onWorkerDeath('exit');
    });
    this.child.on('error', () => {
      this.onWorkerDeath('error');
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
    } else if (msg.kind === 'error' && completed !== undefined) {
      // Job-level inference failure: the worker stays alive, but this job
      // produced no enrichment. Emit the same drop marker as queue_full/
      // worker_dead (reason 'error') so the JSONL gap is honest instead of
      // silent, then drain the next job. rpcId comes from the in-flight job
      // (the worker's error message carries no rpcId). No in-flight job
      // (completed undefined) → no phantom marker, just drain below.
      this.onDrop('error', msg.jobId, completed.request.rpcId);
    }
    // 'skip' is a clean "no PII found": no enrichment AND no marker (not a loss).
    this.drain();
  }

  // Muerte del worker (exit o error). Idempotente via this.alive: si ya estaba
  // muerto, no hace nada. Drena cola + inFlight con onDrop 'worker_dead' y
  // emite un unico onWorkerDied con el total. NO reintenta (decision 7).
  private onWorkerDeath(cause: 'exit' | 'error'): void {
    if (!this.alive) return;
    this.alive = false;
    // FIFO honesto: el inFlight entro antes que cualquier job en cola (fue
    // despachado), asi que se reporta primero en el audit trail.
    const pending =
      this.inFlight !== undefined
        ? [this.inFlight, ...this.queue]
        : [...this.queue];
    this.queue.length = 0;
    this.inFlight = undefined;
    for (const job of pending) {
      this.onDrop('worker_dead', undefined, job.request.rpcId);
    }
    this.onWorkerDied(cause, pending.length);
  }

  // Shutdown limpio (pieza 4). Deja de aceptar enqueues, SIGTERM al worker,
  // espera su muerte con timeout; si expira, SIGKILL. Resuelve siempre, nunca
  // rechaza (consistente con el resto del shutdown defensivo).
  terminate(timeoutMs: number): Promise<void> {
    if (!this.alive) return Promise.resolve();
    this.alive = false;
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        finish();
      }, timeoutMs);
      this.child.once('exit', finish);
      this.child.kill('SIGTERM');
    });
  }
}
