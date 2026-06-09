package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	miru "github.com/takara-ai/miru-code"
	"github.com/takara-ai/miru-code/internal/credentials"
	"github.com/takara-ai/miru-code/internal/embeddings"
	"github.com/takara-ai/miru-code/internal/env"
	"github.com/takara-ai/miru-code/internal/envfiles"
	"github.com/takara-ai/miru-code/internal/installer"
	"github.com/takara-ai/miru-code/internal/mcp"
)

var cliCommands = map[string]bool{
	"search":       true,
	"find-related": true,
	"init":         true,
	"install":      true,
	"uninstall":    true,
	"setup":        true,
	"clear":        true,
	"help":         true,
	"-h":           true,
	"--help":       true,
}

func main() {
	envfiles.Load("", "")
	_, _ = credentials.Load()
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(argv []string) error {
	if len(argv) == 0 {
		return runMCP(argv)
	}

	command := argv[0]
	rest := argv[1:]
	if !cliCommands[command] {
		return runMCP(argv)
	}
	switch command {
	case "-h", "--help":
		printFullHelp()
		return nil
	case "help":
		if len(rest) == 0 {
			printMainHelp()
			return nil
		}
		return printCommandHelp(rest[0])
	case "clear":
		target := "."
		if len(rest) > 0 {
			target = rest[0]
		}
		abs, err := filepath.Abs(target)
		if err != nil {
			return err
		}
		if err := miru.ClearCache(abs); err != nil {
			return err
		}
		fmt.Printf("Cleared cached index for %s\n", abs)
		return nil
	case "search":
		return runSearch(rest)
	case "find-related":
		return runFindRelated(rest)
	case "setup":
		return runSetup(rest)
	case "init":
		return runInit(rest)
	case "install":
		return runInstaller(installer.Install)
	case "uninstall":
		return runInstaller(installer.Uninstall)
	default:
		printMainHelp()
		return fmt.Errorf("unknown command: %s", command)
	}
}

func runInstaller(mode installer.Mode) error {
	if mode == installer.Install {
		if _, err := env.ResolveEmbeddingAPIKey(); err != nil {
			return err
		}
	}
	results, err := installer.Run(mode)
	if err != nil {
		return err
	}
	fmt.Print(installer.FormatResults(results))
	if mode == installer.Install {
		fmt.Fprintln(os.Stderr, "Restart your agents to pick up changes.")
	}
	return nil
}

func runMCP(argv []string) error {
	var ref *string
	contentTokens := []string{}
	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "--ref":
			i++
			if i < len(argv) {
				value := argv[i]
				ref = &value
			}
		case "--content":
			i++
			for i < len(argv) {
				value := argv[i]
				if strings.HasPrefix(value, "-") {
					i--
					break
				}
				contentTokens = append(contentTokens, value)
				i++
			}
		}
	}
	if len(contentTokens) == 0 {
		contentTokens = []string{"code"}
	}
	if _, err := env.ResolveEmbeddingAPIKey(); err != nil {
		return err
	}
	return mcp.Serve(ref, miru.ResolveContent(contentTokens))
}

func runInit(argv []string) error {
	var agent miru.AgentID
	force := false
	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "--force":
			force = true
		case "--agent", "-a":
			i++
			if i < len(argv) {
				agent = miru.AgentID(argv[i])
			}
		}
	}
	if agent == "" {
		_ = printCommandHelp("init")
		return fmt.Errorf("miru init requires --agent")
	}
	dest, err := miru.WriteAgentFile(agent, force)
	if err != nil {
		return err
	}
	fmt.Printf("Wrote sub-agent: %s\n", dest)
	return nil
}

func runSetup(argv []string) error {
	apiKey := ""
	force := false
	clear := false
	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "--force":
			force = true
		case "--clear":
			clear = true
		case "--key", "-k":
			i++
			if i < len(argv) {
				apiKey = argv[i]
			}
		}
	}
	if clear {
		if apiKey != "" {
			return fmt.Errorf("miru setup --clear cannot be combined with --key")
		}
		result, err := credentials.Clear()
		if err != nil {
			return err
		}
		if result.Cleared {
			fmt.Fprintf(os.Stderr, "Removed stored API key from %s\n", result.Path)
		} else {
			fmt.Fprintf(os.Stderr, "No stored API key at %s\n", result.Path)
		}
		return nil
	}
	if !force && env.HasTakaraAPIKeyInEnv() {
		if stored, _ := credentials.Read(); stored != nil {
			fmt.Fprintf(os.Stderr, "API key already configured (env + %s). Use --force to replace stored key.\n", credentials.ResolvePath())
			return nil
		}
		fmt.Fprintln(os.Stderr, "API key already set via environment variable. Stored credentials unchanged.")
		return nil
	}
	if !force {
		if stored, _ := credentials.Read(); stored != nil && apiKey == "" {
			os.Setenv(env.TakaraAPIKeyEnv, stored.TakaraAPIKey)
			fmt.Fprintf(os.Stderr, "API key already stored at %s. Use --force to replace.\n", credentials.ResolvePath())
			return nil
		}
	}
	if apiKey == "" {
		fmt.Fprint(os.Stderr, "Takara API key: ")
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil {
			return err
		}
		apiKey = strings.TrimSpace(line)
	}
	if apiKey == "" {
		return fmt.Errorf("API key cannot be empty")
	}
	result := embeddings.ValidateAPIKey(apiKey, "", "", nil)
	if !result.Valid {
		return fmt.Errorf("%s", result.Message)
	}
	path, err := credentials.Save(apiKey)
	if err != nil {
		return err
	}
	os.Setenv(env.TakaraAPIKeyEnv, apiKey)
	fmt.Fprintf(os.Stderr, "Saved credentials to %s\n", path)
	return nil
}

func runSearch(argv []string) error {
	jsonFlag, rest := parseFlag(argv, "--json")
	content, rest := parseContent(rest)
	topK, rest := parseTopK(rest)
	if len(rest) == 0 {
		return printCommandHelp("search")
	}
	query := rest[0]
	path := "."
	if len(rest) > 1 {
		path = rest[1]
	}
	idx, err := miru.FromSource(path, content)
	if err != nil {
		return err
	}
	if err := idx.SaveToDefaultCache(path); err != nil {
		return err
	}
	results, err := idx.Search(query, topK, nil, nil, nil, nil)
	if err != nil {
		return err
	}
	if jsonFlag {
		return json.NewEncoder(os.Stdout).Encode(miru.FormatResults(query, results))
	}
	printSearchResults(query, results)
	return nil
}

func runFindRelated(argv []string) error {
	jsonFlag, rest := parseFlag(argv, "--json")
	content, rest := parseContent(rest)
	topK, rest := parseTopK(rest)
	if len(rest) < 2 {
		return printCommandHelp("find-related")
	}
	filePath := rest[0]
	line, err := strconv.Atoi(rest[1])
	if err != nil {
		return fmt.Errorf("invalid line: %s", rest[1])
	}
	path := "."
	if len(rest) > 2 {
		path = rest[2]
	}
	idx, err := miru.FromSource(path, content)
	if err != nil {
		return err
	}
	if err := idx.SaveToDefaultCache(path); err != nil {
		return err
	}
	chunk := miru.ResolveChunk(idx.Chunks(), filePath, line)
	if chunk == nil {
		return fmt.Errorf("No chunk found at %s:%d.", filePath, line)
	}
	results, err := idx.FindRelated(*chunk, topK)
	if err != nil {
		return err
	}
	label := fmt.Sprintf("%s:%d", filePath, line)
	if jsonFlag {
		return json.NewEncoder(os.Stdout).Encode(miru.FormatResults(label, results))
	}
	printSearchResults(label, results)
	return nil
}

func parseFlag(argv []string, flag string) (bool, []string) {
	out := []string{}
	present := false
	for _, arg := range argv {
		if arg == flag {
			present = true
			continue
		}
		out = append(out, arg)
	}
	return present, out
}

func parseContent(argv []string) ([]miru.ContentType, []string) {
	contentTokens := []string{}
	rest := []string{}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if arg == "--content" {
			i++
			for i < len(argv) {
				value := argv[i]
				if len(value) > 0 && value[0] == '-' {
					i--
					break
				}
				contentTokens = append(contentTokens, value)
				i++
			}
			continue
		}
		rest = append(rest, arg)
	}
	if len(contentTokens) == 0 {
		contentTokens = []string{"code"}
	}
	return miru.ResolveContent(contentTokens), rest
}

func parseTopK(argv []string) (int, []string) {
	rest := []string{}
	topK := 5
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if arg == "-k" || arg == "--top-k" {
			i++
			if i < len(argv) {
				if value, err := strconv.Atoi(argv[i]); err == nil && value >= 1 {
					topK = value
				}
			}
			continue
		}
		rest = append(rest, arg)
	}
	return topK, rest
}

func printSearchResults(query string, results []miru.SearchResult) {
	if len(results) == 0 {
		fmt.Println("No results found.")
		return
	}
	fmt.Printf("Results for %q\n\n", query)
	for i, result := range results {
		fmt.Printf("%d. %s:%d-%d  %.3f\n", i+1, result.Chunk.FilePath, result.Chunk.StartLine, result.Chunk.EndLine, result.Score)
		fmt.Println(result.Chunk.Content)
		fmt.Println()
	}
}

func printMainHelp() {
	fmt.Println("miru")
	fmt.Println("hybrid code search for agents")
	fmt.Println()
	fmt.Println("Usage")
	fmt.Println("  miru                         Start MCP server (stdio)")
	fmt.Println("  miru <command> [options]")
	fmt.Println()
	fmt.Println("Commands")
	fmt.Println("  search          Hybrid search over a codebase")
	fmt.Println("  find-related    Find chunks related to a file:line")
	fmt.Println("  setup           Save your Takara API key locally")
	fmt.Println("  install         Configure miru across coding agents")
	fmt.Println("  uninstall       Remove miru agent configuration")
	fmt.Println("  init            Write a project-local sub-agent file")
	fmt.Println("  clear           Remove cached index for a path")
	fmt.Println("  help            Show help for a command")
}

func printFullHelp() {
	printMainHelp()
	fmt.Println()
	fmt.Println("Environment")
	fmt.Println("  TAKARA_API_KEY")
	fmt.Println("      Takara bearer token for embeddings")
	fmt.Println("  MIRU_OPENAI_BASE_URL")
	fmt.Println("      Default: https://infer.dev.takara.ai/v1")
	fmt.Println("  MIRU_CONCURRENCY")
	fmt.Println("      Parallel workers (default: CPUs - 2)")
}

func printCommandHelp(command string) error {
	switch command {
	case "search":
		fmt.Println("miru search")
		fmt.Println("Hybrid semantic + keyword search.")
		fmt.Println("Usage: miru search <query> [path] [options]")
		fmt.Println("Options: -k, --top-k N; --content TYPE; --json")
	case "find-related":
		fmt.Println("miru find-related")
		fmt.Println("Semantic neighbors of a file location.")
		fmt.Println("Usage: miru find-related <file> <line> [path] [options]")
	case "setup":
		fmt.Println("miru setup")
		fmt.Println("Store and validate your Takara API key.")
		fmt.Println("Usage: miru setup [--key TOKEN] [--force] [--clear]")
	case "install":
		fmt.Println("miru install")
		fmt.Println("Interactive global agent setup.")
	case "uninstall":
		fmt.Println("miru uninstall")
		fmt.Println("Remove miru configuration from agents.")
	case "init":
		fmt.Println("miru init")
		fmt.Println("Project-local sub-agent file.")
		fmt.Println("Usage: miru init --agent AGENT [--force]")
	case "clear":
		fmt.Println("miru clear")
		fmt.Println("Drop the on-disk index cache.")
		fmt.Println("Usage: miru clear [path]")
	case "mcp":
		fmt.Println("miru mcp")
		fmt.Println("Stdio MCP server (default with no subcommand).")
	default:
		printMainHelp()
		return fmt.Errorf("unknown command: %s", command)
	}
	return nil
}
