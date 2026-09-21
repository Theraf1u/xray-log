package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"github.com/xray-log-analyzer/server/internal/storage"
	"log"
	"fmt"
	"context"
	"crypto/rand"
	"time"
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
	resp := s.buildInstallCommandResponse(r, nodeID)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// buildInstallCommandResponse is the one place that builds the copy-paste
// install command — shared by the typed-node_id flow above and the
// pick-from-panel flow below, so the two can never drift on the command
// format.
func (s *Server) buildInstallCommandResponse(r *http.Request, nodeID string) InstallCommandResponse {
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
	return resp
}

// slugifyNodeID turns a Remnawave panel node name (often mixed Cyrillic,
// punctuation, spaces — "hostbrr de11", "Германия 4 ядра 32тб u1host")
// into something that satisfies nodeIDPattern: lowercase ASCII
// alphanumerics, hyphen-separated. Non-ASCII runs are simply dropped
// rather than transliterated — a lossy but predictable rule, and good
// enough since the result only needs to be a stable, recognizable handle,
// not a faithful rendering of the original name.
func slugifyNodeID(name string) string {
	var b strings.Builder
	lastHyphen := true // swallow any leading hyphen
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	slug := strings.TrimRight(b.String(), "-")
	if len(slug) > 40 {
		slug = strings.TrimRight(slug[:40], "-")
	}
	return slug
}

// uniqueNodeID appends -2, -3, ... to base until it finds a node_id that's
// neither already linked (node_remna_map) nor already seen from a live
// agent (nodes) — see storage.NodeIDTaken.
func (s *Server) uniqueNodeID(ctx context.Context, base string) (string, error) {
	candidate := base
	for i := 2; ; i++ {
		taken, err := s.storage.NodeIDTaken(ctx, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
		suffix := fmt.Sprintf("-%d", i)
		trimmed := base
		if len(trimmed)+len(suffix) > 49 {
			trimmed = trimmed[:49-len(suffix)]
		}
		candidate = trimmed + suffix
	}
}

// CreateNodeFromPanelRequest is the body for POST /api/nodes/create-from-panel.
type CreateNodeFromPanelRequest struct {
	RemnaUUID string `json:"remna_uuid"`
}

// handleCreateNodeFromPanel is the "click a panel node instead of typing a
// name" add-node flow: derives a node_id from the panel node's own name,
// links it (see node_remna_map) *before* any agent exists — so the moment
// the generated command is run and the agent connects, it already shows
// full panel data instead of sitting "не привязана" until someone links
// it by hand afterward — and returns the same install command
// handleNodeInstallCommand would.
//
// Idempotent: picking the same panel node twice reuses its existing link
// and node_id rather than creating a second one.
func (s *Server) handleCreateNodeFromPanel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req CreateNodeFromPanelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RemnaUUID == "" {
		http.Error(w, "remna_uuid is required", http.StatusBadRequest)
		return
	}
	nodeID, err := s.linkNewNodeFromPanel(r.Context(), req.RemnaUUID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	resp := s.buildInstallCommandResponse(r, nodeID)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// linkNewNodeFromPanel is the one place that turns "an admin picked this
// Remnawave panel node" into a node_id: reuse the existing link if this
// panel node was already picked before (idempotent — picking the same
// tile twice, or approving the same pairing code twice, is a no-op rather
// than creating a second orphaned node_id), otherwise derive a fresh slug
// from the panel node's name and link it. Shared by the "Add node" button
// (handleCreateNodeFromPanel) and pairing-code approval
// (handlePairApprove) — the two are the same operation, just triggered
// from different ends (panel-initiated vs. node-initiated).
func (s *Server) linkNewNodeFromPanel(ctx context.Context, remnaUUID string) (string, error) {
	nodeID, err := s.storage.NodeIDForRemnaUUID(ctx, remnaUUID)
	if err == nil {
		return nodeID, nil
	}
	panelNode, perr := s.storage.GetRemnaNodeBasic(ctx, remnaUUID)
	if perr != nil {
		return "", fmt.Errorf("unknown remna_uuid")
	}
	base := slugifyNodeID(panelNode.Name)
	if len(base) < 3 {
		// A name with nothing but non-ASCII characters slugifies to
		// nothing usable — fall back to a short, still-recognizable
		// handle derived from the uuid instead of failing outright.
		base = "node-" + remnaUUID[:8]
	}
	nodeID, err = s.uniqueNodeID(ctx, base)
	if err != nil {
		return "", err
	}
	if err := s.storage.LinkNodeRemna(ctx, nodeID, remnaUUID); err != nil {
		return "", err
	}
	return nodeID, nil
}

// ------------------------------------------------------------------
// Node pairing: the reverse of "click Add node in the panel" — started
// from the node's own terminal instead. A fresh install-agent.sh run
// with no AUTH_TOKEN requests a short code here (unauthenticated, since
// it has no credentials yet), prints it, and polls handlePairStatus.
// The admin sees it in the panel's pending list, picks which Remnawave
// node it is, and approving hands back the shared AGENT_TOKEN plus the
// derived node_id on the node's next poll.
// ------------------------------------------------------------------

const pairingTTL = 15 * time.Minute
const pairingCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I — read aloud over SSH, not typed from a picker

func generatePairingCode() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, 6)
	for i, v := range b {
		out[i] = pairingCodeAlphabet[int(v)%len(pairingCodeAlphabet)]
	}
	return string(out), nil
}

// PairRequestBody is the body for POST /api/nodes/pair/request.
type PairRequestBody struct {
	Hint string `json:"hint"` // hostname/IP the node reports about itself, shown to the admin
}

// handlePairRequest is deliberately unauthenticated — a fresh node has no
// token to authenticate with yet, that's the entire point of pairing.
// What it hands back (a short code) is useless without an admin approving
// it against a specific panel node, so there's nothing sensitive to
// protect here beyond basic abuse (a random requester can only ever
// create harmless, unapproved, 15-minute-lived rows).
func (s *Server) handlePairRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req PairRequestBody
	_ = json.NewDecoder(r.Body).Decode(&req) // hint is optional; malformed body just means no hint
	if len(req.Hint) > 200 {
		req.Hint = req.Hint[:200]
	}

	ctx := r.Context()
	var code string
	for attempt := 0; ; attempt++ {
		c, err := generatePairingCode()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := s.storage.CreatePairingRequest(ctx, c, req.Hint, time.Now().Add(pairingTTL)); err != nil {
			if attempt < 5 {
				continue // code collision (33^6 space, astronomically unlikely, but retry costs nothing)
			}
			http.Error(w, "failed to allocate a pairing code", http.StatusInternalServerError)
			return
		}
		code = c
		break
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"code":               code,
		"expires_in_seconds": int(pairingTTL.Seconds()),
	})
}

// handlePairStatus is polled by the waiting node — also unauthenticated
// for the same reason as handlePairRequest. Once approved it hands back
// the shared AGENT_TOKEN, which is exactly what the panel's own "Add
// node" button already puts in a plaintext copy-paste command — no new
// exposure, just delivered by poll instead of by an admin pasting it.
func (s *Server) handlePairStatus(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("code")))
	if code == "" {
		http.Error(w, "code required", http.StatusBadRequest)
		return
	}
	pr, err := s.storage.GetPairingRequest(r.Context(), code)
	if err != nil {
		http.Error(w, "unknown code", http.StatusNotFound)
		return
	}
	if time.Now().After(pr.ExpiresAt) {
		http.Error(w, "code expired", http.StatusGone)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if !pr.Approved || pr.NodeID == nil {
		_ = json.NewEncoder(w).Encode(map[string]any{"approved": false})
		return
	}
	resp := s.buildInstallCommandResponse(r, *pr.NodeID)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"approved":    true,
		"node_id":     resp.NodeID,
		"server_url":  resp.ServerURL,
		"auth_token":  s.agentToken,
	})
}

// handlePairPending lists not-yet-approved codes for the admin's "Add
// node" picker — authenticated, unlike the two above.
func (s *Server) handlePairPending(w http.ResponseWriter, r *http.Request) {
	pending, err := s.storage.ListPendingPairingRequests(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(pending)
}

// PairApproveRequest is the body for POST /api/nodes/pair/approve.
type PairApproveRequest struct {
	Code      string `json:"code"`
	RemnaUUID string `json:"remna_uuid"`
}

// handlePairApprove is what the admin's click in the panel actually calls:
// link the code's requesting node to the chosen Remnawave panel node
// (same linkNewNodeFromPanel the button-initiated flow uses), then mark
// the code approved so the waiting node's next poll picks it up.
func (s *Server) handlePairApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req PairApproveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" || req.RemnaUUID == "" {
		http.Error(w, "code and remna_uuid are required", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	code := strings.ToUpper(strings.TrimSpace(req.Code))

	nodeID, err := s.linkNewNodeFromPanel(ctx, req.RemnaUUID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := s.storage.ApprovePairingRequest(ctx, code, nodeID); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"node_id": nodeID})
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

// publicInstallScriptURL derives https://<host>/install/<name> the same
// way publicWebSocketURL derives the wss:// URL. The install command used
// to pull the script from raw.githubusercontent.com — harmless while the
// repo was public, but this repo is private now, so that URL 404s for
// everyone. Serving the script from this server instead removes the
// dependency on the GitHub repo's visibility entirely, and guarantees the
// script served always matches the code this server is actually running.
func publicInstallScriptURL(r *http.Request, name string) string {
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	scheme := "https"
	if proto == "http" || (proto == "" && r.TLS == nil) {
		scheme = "http"
	}
	return scheme + "://" + host + "/api/install/" + name
}

// allowedInstallScripts is an explicit allowlist, not a free-form file
// read — handleInstallScript takes the filename straight from the URL
// path, and without this it would be a path-traversal read of anything
// under /app.
var allowedInstallScripts = map[string]string{
	"install-agent.sh":  "/app/scripts/install-agent.sh",
	"install-server.sh": "/app/scripts/install-server.sh",
}

// handleInstallScript serves the node/server install scripts straight off
// this server's own disk. Deliberately unauthenticated — it is meant to be
// piped into `sudo bash` from a brand-new node that has no credentials yet
// and nothing sensitive to protect; the actual secret (AUTH_TOKEN) is only
// ever in the generated command from handleNodeInstallCommand, which does
// require the admin API token.
func (s *Server) handleInstallScript(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/install/")
	path, ok := allowedInstallScripts[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	http.ServeFile(w, r, path)
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
