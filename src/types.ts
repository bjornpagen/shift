export interface Issue {
  file: string
  location: string
  description: string
  explanation: string
  suggestion: string
  reasoning: string
}

export interface KuzuIssue {
  type: string
  from?: string
  to?: string
  description: string
}
