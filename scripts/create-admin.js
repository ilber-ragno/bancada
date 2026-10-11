// Cria uma conta de administrador e mostra a senha temporária uma única vez.
// Uso: npm run create-admin -- <login> "<Nome completo>"
import { assertConfig } from '../src/config.js';
const problems = assertConfig();
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
const { createUser } = await import('../src/users.js');
const [login, ...nameParts] = process.argv.slice(2);
if (!login) { console.error('Uso: npm run create-admin -- <login> "<Nome completo>"'); process.exit(1); }
try {
  const { user, tempPassword } = createUser({ login, name: nameParts.join(' ') || login, role: 'admin', projects: '*' });
  console.log(`Administrador criado: ${user.login}`);
  console.log(`Senha temporária (aparece só agora): ${tempPassword}`);
  console.log('No primeiro acesso a pessoa troca a senha e configura o aplicativo autenticador.');
} catch (e) { console.error('Erro:', e.message); process.exit(1); }
