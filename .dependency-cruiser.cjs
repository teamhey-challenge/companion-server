module.exports = { forbidden: [
 { name: 'sqlite-only-in-stores', severity: 'error', from: { pathNot: '^src/(api-store|social-store|store)\\.ts$' }, to: { path: '^bun:sqlite$' } },
 { name: 'store-no-upward', severity: 'error', from: { path: '^src/(api-store|social-store|store)\\.ts$' }, to: { path: '^src/(talk|social|api)\\.ts$' } },
 { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
], options: { tsPreCompilationDeps: true, doNotFollow: { path: 'node_modules' }, includeOnly: '^src|^bun:' } };
