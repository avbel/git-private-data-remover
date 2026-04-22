export function supportsUnicode(): boolean {
  if (process.platform === 'win32') {
    return false;
  }

  const term = process.env.TERM || '';
  const termProgram = process.env.TERM_PROGRAM || '';

  if (term.includes('256color') || term.includes('truecolor')) {
    return true;
  }

  if (termProgram === 'iTerm.app' || termProgram === 'Apple_Terminal' || termProgram === 'Hyper') {
    return true;
  }

  if (process.env.CI) {
    return false;
  }

  return process.stdout.isTTY || false;
}

export function getTerminalInfo(): { supportsUnicode: boolean; isInteractive: boolean } {
  return {
    supportsUnicode: supportsUnicode(),
    isInteractive: process.stdin.isTTY || false,
  };
}
