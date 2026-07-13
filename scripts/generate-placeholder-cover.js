// Regenerates assets/placeholder-cover.png, the cover published for
// integrations whose own cover is missing or invalid (C.1). The asset is
// committed; this script only exists to make it reproducible.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COVER_HEIGHT, COVER_WIDTH } from '../src/constants.js';
import { createSolidPng } from './lib/createSolidPng.js';

// Gladys primary blue.
const PLACEHOLDER_COLOR = [0x34, 0x67, 0xeb];

const outputPath = fileURLToPath(new URL('../assets/placeholder-cover.png', import.meta.url));
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, createSolidPng(COVER_WIDTH, COVER_HEIGHT, PLACEHOLDER_COLOR));
console.log(`Written ${outputPath}`);
