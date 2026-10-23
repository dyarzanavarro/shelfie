/// <reference types="vite/client" />
import type { LibraryApi } from '../../shared/types'

declare global {
  interface Window {
    api: LibraryApi
  }
}
