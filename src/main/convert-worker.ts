import { parentPort, workerData } from 'node:worker_threads'
import { buildEpub } from './epub/build'
import { readEpubBook } from './epub/read'
import type { EpubMetadata } from './epub/types'
import { buildAzw3 } from './kf8/build'
import { mobiToEpubContent } from './mobi/convert'

const { source, meta, target } = workerData as { source: string; meta: EpubMetadata; target: 'epub' | 'azw3' }
try {
  const data = target === 'azw3' ? buildAzw3(readEpubBook(source), meta) : buildEpub(mobiToEpubContent(source), meta)
  parentPort!.postMessage({ ok: true, data })
} catch (err) {
  parentPort!.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) })
}
