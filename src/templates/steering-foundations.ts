// ============================================================================
// Kiro Foundational Steering Files — Progressive Disclosure Paradigm
// ONLY 2 files with inclusion: always (prevents context rot)
// Everything else uses auto/fileMatch (loaded on demand)
// ============================================================================

export const PRODUCT_MD = `---
inclusion: always
---

# Contexto del Proyecto

> Actualizar con información real del proyecto. Kiro lee esto en CADA interacción.

## Qué es este proyecto

_Descripción breve: qué hace, para quién, por qué existe._

## Stack principal

_Listar tecnologías principales con versiones._

## Estado actual

_Qué funciona, qué falta, riesgos conocidos._
`;

export const SECURITY_MD = `---
inclusion: always
---

# Política de Seguridad

## Reglas inquebrantables

- Nunca hardcodear secrets, tokens o passwords
- Nunca commitear archivos .env
- Nunca deshabilitar controles de seguridad o audit logging
- Nunca usar \`except: pass\` o swallowing silencioso de errores
- Validar todos los inputs en endpoints
- Usar queries parametrizadas (nunca concatenación SQL)
- Registrar audit trail en operaciones sensibles
`;
