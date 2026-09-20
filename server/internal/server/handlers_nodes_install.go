package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// nodeIDPattern matches what install-agent.sh and the WebSocket handshake
// both accept as a node_id: safe to interpolate into a shell command and
// safe to use as a Docker Compose project/container name component.
var nodeIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`)

// InstallCommandResponse is the copy-paste-ready agent install command for a
// new node — see scripts/install-agent.sh. The agent token is returned in
// full (not masked): the command is useless without it, and this endpoint
// requires the same API token every other admin-level endpoint does.
type InstallCommandResponse struct {
	NodeID    string `json:"node_id"`
	ServerURL string `json:"server_url"`
	Command   string `json:"command"`
	AlreadyUp bool   `json:"already_connected"`
}

// handleNodeInstallCommand builds the one-line install command for a new
// node, using the same AGENT_TOKEN every already-connected node was set up
// with and a wss:// URL derived from how the browser itself reached this
// server — so it works whether the deployment sits behind xray.24w.shop,
// an IP, or a future domain, without a hardcoded hostname.
func (s *Server) handleNodeInstallCommand(w http.ResponseWriter, r *http.Request) {
	nodeID := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("node_id")))
	if nodeID == "" {
		http.Error(w, "node_id required", http.StatusBadRequest)
		return
	}
	if !nodeIDPattern.MatchString(nodeID) {
		http.Error(w, "node_id must be 3-50 lowercase letters, digits or hyphens, and not start/end with a hyphen", http.StatusBadRequest)
		return
	}

	s.clientsMu.RLock()
	_, alreadyUp := s.clients[nodeID]
	s.clientsMu.RUnlock()

	serverURL := publicWebSocketURL(r)

	resp := InstallCommandResponse{
		NodeID:    nodeID,
		ServerURL: serverURL,
		AlreadyUp: alreadyUp,
	}
	if s.agentToken == "" {
		resp.Command = "# AGENT_TOKEN не задан на сервере — задайте его в .env, иначе агенты не смогут подключиться"
	} else {
		resp.Command = "curl -fsSL https://raw.githubusercontent.com/qwertyhq/xray-analyzer/main/scripts/install-agent.sh | sudo " +
			"SERVER_URL=\"" + serverURL + "\" " +
			"AUTH_TOKEN=\"" + s.agentToken + "\" " +
			"NODE_ID=\"" + nodeID + "\" " +
			"bash"
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// publicWebSocketURL derives wss://<host>/ws from the request the browser
// actually sent, honouring X-Forwarded-Proto/Host from a reverse proxy
// (nginx-proxy-manager in front of this deployment) and falling back to the
// request's own Host when unproxied.
func publicWebSocketURL(r *http.Request) string {
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	scheme := "wss"
	if proto == "http" || (proto == "" && r.TLS == nil) {
		scheme = "ws"
	}
	return scheme + "://" + host + "/ws"
}
