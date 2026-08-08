import { isAbsolute, relative } from 'node:path';

export const isOutside = (root, candidate) => {
  const value = relative(root, candidate);
  return value === '..' || value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(value);
};
