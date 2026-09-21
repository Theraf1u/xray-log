package server

import (
	"archive/zip"
	"compress/flate"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/xray-log-analyzer/server/internal/storage"
)

var exportPeriods = map[string]time.Duration{
	"1h": time.Hour, "12h": 12 * time.Hour, "24h": 24 * time.Hour,
	"7d": 7 * 24 * time.Hour, "14d": 14 * 24 * time.Hour, "30d": 30 * 24 * time.Hour,
}

var exportTimezones = map[string]string{
	"UTC":                "UTC (UTC+0)",
	"Europe/Kaliningrad": "Калининград (UTC+2)",
	"Europe/Moscow":      "Москва (UTC+3)",
	"Europe/Samara":      "Самара (UTC+4)",
	"Asia/Yekaterinburg": "Екатеринбург (UTC+5)",
	"Asia/Omsk":          "Омск (UTC+6)",
	"Asia/Novosibirsk":   "Новосибирск (UTC+7)",
	"Asia/Irkutsk":       "Иркутск (UTC+8)",
	"Asia/Yakutsk":       "Якутск (UTC+9)",
	"Asia/Vladivostok":   "Владивосток (UTC+10)",
	"Asia/Magadan":       "Магадан (UTC+11)",
	"Asia/Kamchatka":     "Камчатка (UTC+12)",
}

// handleRequestExport serves both the on-screen preview and streamed CSV.
func (s *Server) handleRequestExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := strings.TrimSpace(r.URL.Query().Get("user"))
	if user == "" {
		http.Error(w, "user is required", http.StatusBadRequest)
		return
	}
	period := r.URL.Query().Get("period")
	duration, ok := exportPeriods[period]
	if !ok && period != "all" {
		http.Error(w, "invalid period", http.StatusBadRequest)
		return
	}
	since := time.Unix(0, 0).UTC()
	if period != "all" {
		since = time.Now().UTC().Add(-duration)
	}
	tzName := r.URL.Query().Get("tz")
	if tzName == "" {
		tzName = "Europe/Moscow"
	}
	tzLabel, ok := exportTimezones[tzName]
	if !ok {
		http.Error(w, "invalid timezone", http.StatusBadRequest)
		return
	}
	location, err := time.LoadLocation(tzName)
	if err != nil {
		http.Error(w, "timezone unavailable", http.StatusInternalServerError)
		return
	}
	format := r.URL.Query().Get("format")
	if format == "csv" {
		s.handleRequestExportCSV(w, r, user, period, since, location, tzLabel)
		return
	}
	if format == "xlsx" {
		s.handleRequestExportXLSX(w, r, user, period, since, location, tzLabel)
		return
	}

	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 1000 {
			limit = parsed
		}
	}
	events, err := s.storage.GetRequestEvents(r.Context(), user, since, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"user": user, "period": period, "since": since, "timezone": tzName, "timezone_label": tzLabel, "events": events})
}

const maxXLSXDataRows = 1048575 // Excel row limit minus the header row.

func (s *Server) handleRequestExportXLSX(w http.ResponseWriter, r *http.Request, user, period string, since time.Time, location *time.Location, timezoneLabel string) {
	xlsxName := fmt.Sprintf("xray-requests-%s-%s-%s.xlsx", safeFilename(user), period, time.Now().UTC().Format("20060102-150405"))
	zipName := strings.TrimSuffix(xlsxName, ".xlsx") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, zipName))
	w.Header().Set("Cache-Control", "no-store")

	// An .xlsx is itself a zip, but the writer below emits every cell as a
	// verbose inlineStr XML element (repeated domains/tags/statuses), and
	// zip.Writer's default Deflate level leaves real redundancy on the
	// table — rewrapping the finished xlsx bytes at BestCompression measured
	// ~30% smaller on a real 94k-row export. outerEntry below streams
	// straight into that max-compression pass; nothing is buffered in memory.
	outer := zip.NewWriter(w)
	outer.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestCompression)
	})
	outerEntry, err := outer.Create(xlsxName)
	if err != nil {
		_ = outer.Close()
		return
	}
	zw := zip.NewWriter(outerEntry)
	headers := []string{"Время — " + timezoneLabel, "Пользователь", "Нода", "IP пользователя", "Порт источника", "Протокол", "Назначение", "Входящий тег", "Исходящий тег", "Статус"}
	sheetCount, dataRows, rowNumber := 0, 0, 0
	var sheet io.Writer

	startSheet := func() error {
		sheetCount++
		dataRows = 0
		rowNumber = 1
		var err error
		sheet, err = zw.Create(fmt.Sprintf("xl/worksheets/sheet%d.xml", sheetCount))
		if err != nil {
			return err
		}
		_, err = io.WriteString(sheet, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="21" customWidth="1"/><col min="2" max="2" width="24" customWidth="1"/><col min="3" max="3" width="22" customWidth="1"/><col min="4" max="4" width="20" customWidth="1"/><col min="5" max="6" width="15" customWidth="1"/><col min="7" max="7" width="42" customWidth="1"/><col min="8" max="10" width="22" customWidth="1"/></cols><sheetData>`)
		if err != nil {
			return err
		}
		return writeXLSXRow(sheet, rowNumber, headers, 1)
	}
	endSheet := func() error {
		if sheet == nil {
			return nil
		}
		_, err := io.WriteString(sheet, `</sheetData><autoFilter ref="A1:J1"/></worksheet>`)
		return err
	}
	if err := startSheet(); err != nil {
		_ = zw.Close()
		return
	}

	err = s.storage.StreamRequestEvents(r.Context(), user, since, func(event storage.RequestEvent) error {
		if dataRows == maxXLSXDataRows {
			if err := endSheet(); err != nil {
				return err
			}
			if err := startSheet(); err != nil {
				return err
			}
		}
		dataRows++
		rowNumber++
		return writeXLSXRow(sheet, rowNumber, []string{
			event.Timestamp.In(location).Format("2006-01-02 15:04:05"), user, event.NodeID,
			event.SourceIP, strconv.Itoa(event.SourcePort), event.Protocol,
			event.Destination, event.Inbound, event.Outbound, event.Status,
		}, 0)
	})
	if err == nil {
		err = endSheet()
	}
	if err == nil {
		err = writeXLSXPackageFiles(zw, sheetCount)
	}
	if closeErr := zw.Close(); err == nil {
		err = closeErr
	}
	if closeErr := outer.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		fmt.Printf("xlsx export failed for %q: %v\n", user, err)
	}
}

func writeXLSXRow(w io.Writer, row int, values []string, style int) error {
	if _, err := fmt.Fprintf(w, `<row r="%d">`, row); err != nil {
		return err
	}
	for i, value := range values {
		ref := string(rune('A'+i)) + strconv.Itoa(row)
		if _, err := fmt.Fprintf(w, `<c r="%s" t="inlineStr" s="%d"><is><t xml:space="preserve">`, ref, style); err != nil {
			return err
		}
		if err := xml.EscapeText(w, []byte(cleanXMLText(value))); err != nil {
			return err
		}
		if _, err := io.WriteString(w, `</t></is></c>`); err != nil {
			return err
		}
	}
	_, err := io.WriteString(w, `</row>`)
	return err
}

func cleanXMLText(v string) string {
	return strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' || r >= 0x20 {
			return r
		}
		return -1
	}, v)
}

func writeXLSXPackageFiles(zw *zip.Writer, sheetCount int) error {
	write := func(name, body string) error {
		f, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = io.WriteString(f, body)
		return err
	}
	if err := write("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`); err != nil {
		return err
	}

	var types, workbook, rels strings.Builder
	types.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`)
	workbook.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`)
	rels.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for i := 1; i <= sheetCount; i++ {
		fmt.Fprintf(&types, `<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, i)
		fmt.Fprintf(&workbook, `<sheet name="Логи %d" sheetId="%d" r:id="rId%d"/>`, i, i, i)
		fmt.Fprintf(&rels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`, i, i)
	}
	styleRelID := sheetCount + 1
	fmt.Fprintf(&rels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`, styleRelID)
	types.WriteString(`</Types>`)
	workbook.WriteString(`</sheets></workbook>`)
	rels.WriteString(`</Relationships>`)
	if err := write("[Content_Types].xml", types.String()); err != nil {
		return err
	}
	if err := write("xl/workbook.xml", workbook.String()); err != nil {
		return err
	}
	if err := write("xl/_rels/workbook.xml.rels", rels.String()); err != nil {
		return err
	}
	return write("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
}

func (s *Server) handleRequestExportCSV(w http.ResponseWriter, r *http.Request, user, period string, since time.Time, location *time.Location, timezoneLabel string) {
	// Access logs can run to hundreds of thousands of rows; CSV text
	// compresses extremely well (repetitive columns), so ship it zipped
	// instead of making the browser pull the raw text over the wire.
	csvName := fmt.Sprintf("xray-requests-%s-%s-%s.csv", safeFilename(user), period, time.Now().UTC().Format("20060102-150405"))
	zipName := strings.TrimSuffix(csvName, ".csv") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, zipName))
	w.Header().Set("Cache-Control", "no-store")

	zw := zip.NewWriter(w)
	defer zw.Close()
	csvEntry, err0 := zw.Create(csvName)
	if err0 != nil {
		fmt.Printf("request export failed for %q: %v\n", user, err0)
		return
	}
	_, _ = csvEntry.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(csvEntry)
	_ = cw.Write([]string{"Время — " + timezoneLabel, "Пользователь", "Нода", "IP пользователя", "Порт источника", "Протокол", "Назначение", "Входящий тег", "Исходящий тег", "Статус"})
	count := 0
	err := s.storage.StreamRequestEvents(r.Context(), user, since, func(event storage.RequestEvent) error {
		row := []string{event.Timestamp.In(location).Format("2006-01-02 15:04:05"), user, event.NodeID, event.SourceIP,
			strconv.Itoa(event.SourcePort), event.Protocol, event.Destination, event.Inbound, event.Outbound, event.Status}
		for i := range row {
			row[i] = csvSafe(row[i])
		}
		if err := cw.Write(row); err != nil {
			return err
		}
		count++
		if count%1000 == 0 {
			cw.Flush()
			return cw.Error()
		}
		return nil
	})
	cw.Flush()
	if err != nil || cw.Error() != nil {
		fmt.Printf("request export failed for %q: %v %v\n", user, err, cw.Error())
	}
}

func csvSafe(v string) string {
	if v != "" && strings.ContainsRune("=+-@", rune(v[0])) {
		return "'" + v
	}
	return v
}

func safeFilename(v string) string {
	v = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, v)
	v = strings.Trim(v, "-")
	if v == "" {
		return "user"
	}
	if len(v) > 80 {
		return v[:80]
	}
	return v
}
