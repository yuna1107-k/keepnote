// テスト（npm test）。画面のビルドの設定（vite.config.ts。root が src/web）とは分ける
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
