declare module 'claude-code' {
  interface PluginState {
    pn: {
      listing: Shaped<Listing>
      selected: string
      focused: number
    }
  }
}

export type CiState = 'pass' | 'fail' | 'pending' | 'none'

export type PrStatus = 'draft' | 'conflict' | 'changes' | 'approved' | 'review' | 'none'

export interface PullRequest {
  number: number
  title: string
  url: string
  author: string
  ci: CiState
  status: PrStatus
  updatedAt?: number
}

export interface Repo {
  slug: string
  name: string
  prs: PullRequest[]
  error?: string
}

// `isCut`: the search below the session's folder was given up, so `scanned` may miss repos.
export type Listing = { status: 'loading' } | { status: 'loaded'; repos: Repo[]; scanned: number; isCut: boolean }
