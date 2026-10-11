// Ambiente isolado para os testes
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bancada-teste-'));
process.env.BANCADA_SECRET_KEY = 'a'.repeat(64);
process.env.SSH_KEY_PATH = '/dev/null';
