package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"github.com/xray-log-analyzer/server/internal/storage"
	"log"
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
		resp.Command = "curl -fsSL https://raw.githubusercontent.com/Theraf1u/xray-log/main/scripts/install-agent.sh | sudo " +
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


// RemnaNodeOptionView adds the live, verified connection state of the
// linked agent (if any) to storage.RemnaNodeOption. "Linked" only means a
// row exists in node_remna_map — it says nothing about whether that agent
// is actually talking to us right now, so the picker checks the live
// WebSocket client map rather than trusting the DB link blindly.
type RemnaNodeOptionView struct {
	*storage.RemnaNodeOption
	LinkedAgentConnected *bool `json:"linked_agent_connected,omitempty"`
}

// handleRemnaNodesList returns every synced Remnawave panel node for the
// manual link picker (see node_remna_map in schema.sql for why linking is
// manual: node_id and the panel's node name follow no reliable convention,
// and the panel has many stale/duplicate entries).
func (s *Server) handleRemnaNodesList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	opts, err := s.storage.ListRemnaNodeOptions(ctx)
	if err != nil {
		log.Printf("handleRemnaNodesList: %v", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.clientsMu.RLock()
	views := make([]*RemnaNodeOptionView, 0, len(opts))
	for _, o := range opts {
		v := &RemnaNodeOptionView{RemnaNodeOption: o}
		if o.LinkedTo != nil {
			_, connected := s.clients[*o.LinkedTo]
			views = append(views, &RemnaNodeOptionView{RemnaNodeOption: o, LinkedAgentConnected: &connected})
			continue
		}
		views = append(views, v)
	}
	s.clientsMu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(views)
}

// LinkNodeRemnaRequest is the body for POST /api/nodes/link-remnawave.
type LinkNodeRemnaRequest struct {
	NodeID    string `json:"node_id"`
	RemnaUUID string `json:"remna_uuid"`
}

// handleLinkNodeRemna records an admin-chosen link between an agent node_id
// and a Remnawave panel node. Always an explicit admin action — never
// inferred automatically.
func (s *Server) handleLinkNodeRemna(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req LinkNodeRemnaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.NodeID == "" || req.RemnaUUID == "" {
		http.Error(w, "node_id and remna_uuid are required", http.StatusBadRequest)
		return
	}
	if err := s.storage.LinkNodeRemna(r.Context(), req.NodeID, req.RemnaUUID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// UnlinkNodeRemnaRequest is the body for POST /api/nodes/unlink-remnawave.
type UnlinkNodeRemnaRequest struct {
	NodeID string `json:"node_id"`
}

// handleUnlinkNodeRemna removes a previously approved link.
func (s *Server) handleUnlinkNodeRemna(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req UnlinkNodeRemnaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.NodeID == "" {
		http.Error(w, "node_id is required", http.StatusBadRequest)
		return
	}
	if err := s.storage.UnlinkNodeRemna(r.Context(), req.NodeID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}


// handleNodesLive serves the ~1s poll behind the nodes page's live speed,
// uptime and connection-count display. Deliberately its own tiny endpoint
// rather than folded into /api/nodes: that response is cached for 10s and
// carries every column, both wrong for something polled every second.
func (s *Server) handleNodesLive(w http.ResponseWriter, r *http.Request) {
	live, err := s.storage.GetNodesLive(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(live)
}
