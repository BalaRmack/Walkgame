// Копирует статичные ассеты renderer'а (HTML/CSS) в dist/ после компиляции TypeScript.
// Работает одинаково на Windows/Linux/macOS (без shell-утилит вроде cp).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'renderer');
const to = join(root, 'dist', 'renderer');

mkdirSync(to, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  cpSync(join(from, file), join(to, file));
}
console.log('[copy-assets] renderer assets -> dist/renderer');
