package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"
)

// gzipWriter is a pool of reusable compressors: a dashboard page pulls several
// large JSON documents at once and allocating a fresh gzip.Writer per response
// would churn memory for no reason.
var gzipWriterPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return w
	},
}

// gzipResponseWriter compresses the body while leaving status and headers to
// the wrapped writer.
type gzipResponseWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) { return w.gz.Write(b) }

// Flush keeps periodically-flushed handlers working; the compressor is flushed
// first so bytes actually reach the client.
func (w *gzipResponseWriter) Flush() {
	_ = w.gz.Flush()
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// compress gzips JSON API responses.
//
// The API was shipping plain JSON: /api/remnawave/abuse alone is ~600KB and
// /api/users/all ~470KB, so opening one page pushed well over a megabyte down
// the wire. That is invisible on localhost and painful over the internet,
// which is exactly the "pages take 5-10 seconds" symptom.
//
// Deliberately skipped:
//   - /ws* — hijacked connections, never written through this writer;
//   - /api/ai/chat/stream — SSE, where buffering would stall the stream;
//   - clients that did not advertise gzip.
func (s *Server) compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			strings.HasPrefix(path, "/ws") ||
			strings.HasPrefix(path, "/api/ai/chat/stream") {
			next.ServeHTTP(w, r)
			return
		}

		gz := gzipWriterPool.Get().(*gzip.Writer)
		gz.Reset(w)
		defer func() {
			_ = gz.Close()
			gzipWriterPool.Put(gz)
		}()

		// Content-Length would describe the uncompressed body, and caches must
		// not treat the two encodings as one document.
		w.Header().Del("Content-Length")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")

		next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, gz: gz}, r)
	})
}
