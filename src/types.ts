export interface LineRange {
  start: number;
  end: number;
}

export interface LineInfo {
  lineNumber: number;
  content: string;
  commitHash: string;
  originalLineNumber: number;
}

export interface Replacement {
  lineNumber: number;
  originalContent: string;
  replacementContent: string;
}

export interface CommitReplacements {
  commitHash: string;
  lines: Replacement[];
}


