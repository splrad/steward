import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

class WindowsCISequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    const ordered = await super.sort(files);
    // On a fresh runner Vitest sorts by file size. These small entry files
    // exercise independent, minutes-long Git scenarios in a shared fixture.
    const isCandidateSuite = (file: TestSpecification) =>
      file.moduleId.replaceAll('\\', '/').includes('/packages/runner/test/release-candidate-native.');
    return [...ordered.filter(isCandidateSuite), ...ordered.filter(file => !isCandidateSuite(file))];
  }
}

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    ...(process.platform === 'win32' ? { maxWorkers: 2 } : {}),
    ...(process.platform === 'win32' && process.env.CI ? { sequence: { sequencer: WindowsCISequencer } } : {}),
    reporters: process.platform === 'win32' ? ['verbose'] : ['default'],
    setupFiles: ['packages/runner/test/offline-setup.ts'],
    coverage: { enabled: false },
  },
});
