/**
 * Script de actualización de cuenta admin → superadmin
 *
 * Uso (con el backend DETENIDO):
 *   cd SP_Dian_V2/backend
 *   npx ts-node scripts/set-superadmin.ts
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as bcrypt from 'bcryptjs';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { AppDataSource } from '../src/config/database';
import { User } from '../src/entities/User';

async function main() {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(User);

  // ── 1. Actualizar usuario existente ─────────────────────────────────────
  const existing = await repo.findOne({ where: { email: 'admin@akribeia.co' } });

  if (existing) {
    existing.role  = 'superadmin';
    existing.email = 'gesis2@neurum.com.co';
    existing.name  = 'Alejandro Vargas';
    await repo.save(existing);
    console.log('✓ Usuario actualizado:', existing.email, '→ superadmin');
  } else {
    // ── 2. Si ya existe con el nuevo email, solo actualizar rol ─────────────
    const byNewEmail = await repo.findOne({ where: { email: 'gesis2@neurum.com.co' } });
    if (byNewEmail) {
      byNewEmail.role = 'superadmin';
      byNewEmail.name = 'Alejandro Vargas';
      await repo.save(byNewEmail);
      console.log('✓ Rol actualizado a superadmin:', byNewEmail.email);
    } else {
      console.log('⚠ No se encontró ningún usuario. Creando superadmin desde cero...');
      // Buscar la empresa existente
      const companies = await AppDataSource.query('SELECT id FROM companies LIMIT 1');
      if (!companies.length) {
        console.error('✗ No hay empresas en la BD. Corre el setup primero.');
        process.exit(1);
      }
      const hash = await bcrypt.hash('Admin2024!', 12);
      const user = repo.create({
        company_id:    companies[0].id,
        email:         'gesis2@neurum.com.co',
        name:          'Alejandro Vargas',
        password_hash: hash,
        role:          'superadmin',
      });
      await repo.save(user);
      console.log('✓ Usuario superadmin creado. Contraseña temporal: Admin2024!');
      console.log('  → Cámbiala en Configuración > Usuarios');
    }
  }

  await AppDataSource.destroy();
  console.log('✓ Listo.');
}

main().catch(e => { console.error(e); process.exit(1); });
