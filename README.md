# Devia

**Devia** es una aplicación de escritorio (Windows, macOS y Linux) de **código abierto** para trabajar con agentes de codificación CLI —Claude Code, Codex, Gemini CLI, OpenCode, Pi y más— desde una sola ventana, sin terminal y sin nube.

[English](README.en.md) · [Descargas](https://dherrero.github.io/devia/descargas/) · [Documentación](https://dherrero.github.io/devia/docs/) · [Releases](https://github.com/dherrero/devia/releases)

## Qué incluye

- Chat con streaming, visor de diffs y comentarios por línea con "Enviar a revisar".
- Vista dividida con hasta 4 agentes en paralelo, aislados en git worktrees.
- Kanban spec-driven integrado, memoria persistente y gestor de servidores MCP.
- Control remoto por Telegram, transcripción de voz local, terminal y cambio de rama.
- Todo funciona en local, sobre tus proyectos y tus CLIs.

## Instalar

Descarga el instalador desde la [página de descargas](https://dherrero.github.io/devia/descargas/). La app se actualiza sola desde las [Releases](https://github.com/dherrero/devia/releases).

## Desarrollo

```bash
nvm use && npm install
npm run build:desktop && npm run dev:desktop
```

| Ruta | Contenido |
| --- | --- |
| [`apps/desktop`](apps/desktop) | La app: proceso principal de Electron + renderer Angular 21 |
| [`libs/ui`](libs/ui), [`libs/styles`](libs/styles) | Componentes y tokens de diseño compartidos |

Guías: [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) · [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) · [SECURITY.md](SECURITY.md).

## Licencia

[Apache-2.0](LICENSE) · © 2024-2026 Daniel Herrero Tomás y Ruben Sanz Rosa. Ver [NOTICE](NOTICE).
