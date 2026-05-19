// ============================================================================
// AGENTS.md — Cross-IDE standard (AAIF / Linux Foundation)
// Progressive Disclosure: ONLY permissions here. Standards go in steering.
// Target: under 100 lines
// ============================================================================

export const AGENTS_MD_TEMPLATE = `# AGENTS.md

> Estándar cross-IDE (AAIF/Linux Foundation). Lo lee Kiro, Claude Code, Cursor, Copilot.

## Permisos del Agente

### ✅ Permitido
- Leer cualquier archivo del repositorio
- Modificar código fuente en src/, app/, lib/, packages/
- Ejecutar tests, linting, type checking
- Crear archivos nuevos siguiendo convenciones del proyecto
- Refactorizar código

### ⚠️ Requiere revisión (explicar antes de proceder)
- Modificar infraestructura (Dockerfile, helm/, terraform/, CI/CD)
- Cambiar lógica de autenticación o autorización
- Modificar manejo de credenciales o encriptación
- Alterar schemas de base de datos o migraciones

### 🚫 Prohibido
- Exponer o loguear secrets, tokens, API keys
- Deshabilitar controles de seguridad o audit logging
- Commitear archivos .env o credenciales hardcodeadas
- Ejecutar operaciones destructivas en datos de producción

## Referencia

Para estándares de código → ver .kiro/steering/
Para skills específicos → ver .kiro/skills/
`;
