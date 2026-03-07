import type { Config } from 'jest';

const config: Config = {
  preset:              'ts-jest',
  testEnvironment:     'node',
  testMatch:           ['**/tests/**/*.test.ts'],
  testTimeout:         15000,
  // Corre los archivos de test en serie para evitar conflictos en la DB
  maxWorkers:          1,
  forceExit:           true,
};

export default config;
