import { parentPort, workerData } from 'node:worker_threads'
import { buildEpub } from './epub/build'
import type { EpubMetadata } from './epub/types'
import { mobiToEpubContent } from './mobi/convert'

const { source, meta } = workerData as { source: string; meta: EpubMetadata }
try {
  parentPort!.postMessage({ ok: true, epub: buildEpub(mobiToEpubContent(source), meta) })
} catch (err) {
  parentPort!.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) })
}
