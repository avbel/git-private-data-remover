export interface LineRange {
  start: number;
  end: number;
}

export interface LineInfo {
  lineNumber: number;
  content: string;
  commitHash: string;
  originalLineNumber: number;
  originalFile: string;
}

export interface Replacement {
  lineNumber: number;
  originalContent: string;
  replacementContent: string;
}

export interface CommitReplacements {
  commitHash: string;
  file?: string;
  lines: Replacement[];
}

export interface RepoFile {
  toplevel: string;
  relativePath: string;
  tracked: boolean;
}

export interface ContentHit {
  hash: string;
  file: string;
  lines: string[];
}
