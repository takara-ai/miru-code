import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_ROOT = `${process.env.HOME ?? ""}/.cache/semble-bench`;
export const MIRU_ROOT = dirname(fileURLToPath(new URL("..", import.meta.url)));
export const TOP_K = 5;

export interface BenchQuery {
  query: string;
  relevant: string[];
  category: string;
}

export interface RepoBench {
  name: string;
  language: string;
  path: string;
  queries: BenchQuery[];
}

export const REPO_BENCHES: RepoBench[] = [
  {
    name: "miru-code",
    language: "typescript",
    path: MIRU_ROOT,
    queries: [
      {
        query: "CLI entry point main command line interface",
        relevant: ["src/cli.ts", "package.json"],
        category: "entry",
      },
      {
        query: "hybrid search ranking BM25 embedding score fusion",
        relevant: ["src/search.ts"],
        category: "architecture",
      },
      {
        query: "where is cli-ui terminal output formatting",
        relevant: ["src/cli-ui.ts"],
        category: "location",
      },
    ],
  },
  {
    name: "flask",
    language: "python",
    path: `${BENCH_ROOT}/flask`,
    queries: [
      {
        query: "Flask application class request handling WSGI",
        relevant: ["src/flask/app.py"],
        category: "architecture",
      },
      {
        query: "blueprint route registration",
        relevant: ["src/flask/blueprints.py", "src/flask/app.py"],
        category: "semantic",
      },
      {
        query: "Flask CLI command line interface",
        relevant: ["src/flask/cli.py"],
        category: "entry",
      },
    ],
  },
  {
    name: "fastapi",
    language: "python",
    path: `${BENCH_ROOT}/fastapi`,
    queries: [
      {
        query: "FastAPI application routing path operations",
        relevant: ["fastapi/routing.py", "fastapi/applications.py"],
        category: "architecture",
      },
      {
        query: "dependency injection Depends",
        relevant: ["fastapi/dependencies/utils.py", "fastapi/param_functions.py"],
        category: "semantic",
      },
      {
        query: "OpenAPI schema generation",
        relevant: ["fastapi/openapi/utils.py", "fastapi/openapi/models.py"],
        category: "semantic",
      },
    ],
  },
  {
    name: "click",
    language: "python",
    path: `${BENCH_ROOT}/click`,
    queries: [
      {
        query: "command line interface Click command decorator",
        relevant: ["src/click/core.py", "src/click/decorators.py"],
        category: "architecture",
      },
      {
        query: "argument option parsing CLI",
        relevant: ["src/click/core.py", "src/click/parser.py"],
        category: "semantic",
      },
    ],
  },
  {
    name: "axum",
    language: "rust",
    path: `${BENCH_ROOT}/axum`,
    queries: [
      {
        query: "HTTP router route matching axum",
        relevant: ["axum/src/routing/mod.rs", "axum/src/routing/path_router.rs"],
        category: "architecture",
      },
      {
        query: "extract request body handler",
        relevant: ["axum/src/extract/mod.rs", "axum/src/extract/query.rs"],
        category: "semantic",
      },
      {
        query: "middleware layer tower",
        relevant: ["axum/src/middleware/mod.rs"],
        category: "semantic",
      },
    ],
  },
  {
    name: "serde",
    language: "rust",
    path: `${BENCH_ROOT}/serde`,
    queries: [
      {
        query: "Serialize Deserialize trait derive",
        relevant: ["serde/src/lib.rs", "serde/src/ser/mod.rs"],
        category: "architecture",
      },
      {
        query: "JSON serialization deserializer",
        relevant: ["serde/src/ser/mod.rs", "serde/src/de/mod.rs"],
        category: "semantic",
      },
    ],
  },
  {
    name: "gin",
    language: "go",
    path: `${BENCH_ROOT}/gin`,
    queries: [
      {
        query: "gin HTTP router middleware engine",
        relevant: ["gin.go", "routergroup.go"],
        category: "architecture",
      },
      {
        query: "request context binding JSON",
        relevant: ["context.go", "binding.go"],
        category: "semantic",
      },
    ],
  },
  {
    name: "cobra",
    language: "go",
    path: `${BENCH_ROOT}/cobra`,
    queries: [
      {
        query: "cobra command CLI execute flags",
        relevant: ["command.go"],
        category: "architecture",
      },
      {
        query: "persistent flags command tree",
        relevant: ["command.go", "flag_groups.go"],
        category: "semantic",
      },
    ],
  },
  {
    name: "express",
    language: "javascript",
    path: `${BENCH_ROOT}/express`,
    queries: [
      {
        query: "express application middleware routing",
        relevant: ["lib/application.js", "lib/express.js"],
        category: "architecture",
      },
      {
        query: "request response HTTP handlers",
        relevant: ["lib/request.js", "lib/response.js"],
        category: "semantic",
      },
    ],
  },
  {
    name: "phoenix",
    language: "elixir",
    path: `${BENCH_ROOT}/phoenix`,
    queries: [
      {
        query: "Phoenix router HTTP pipeline plugs",
        relevant: ["lib/phoenix/router.ex", "lib/phoenix/router/route.ex"],
        category: "architecture",
      },
      {
        query: "channel websocket pubsub",
        relevant: ["lib/phoenix/channel.ex", "lib/phoenix/socket.ex"],
        category: "semantic",
      },
    ],
  },
  {
    name: "rails",
    language: "ruby",
    path: `${BENCH_ROOT}/rails`,
    queries: [
      {
        query: "Rails routing route set dispatch",
        relevant: [
          "actionpack/lib/action_dispatch/routing/route_set.rb",
          "actionpack/lib/action_dispatch/routing/mapper.rb",
        ],
        category: "architecture",
      },
      {
        query: "ActiveRecord database model persistence",
        relevant: ["activerecord/lib/active_record/base.rb"],
        category: "semantic",
      },
    ],
  },
];

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
