package market

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
)

type stateV4 struct {
	Seed               string
	RNG                uint32
	Seq, Tick          int64
	Date               string
	Seconds, DayIndex  int64
	FeePool, TotalCash int64
	Wallets            []*wallet
	Stocks             []*stock
	Orders             map[string]*internalOrder
	Players            map[string]*player
	PlayerIDs          []string
	News               []newsItemV4
	Macro              float64
	SectorFactors      map[string]float64
	TotalShares        map[string]int64
	Companies          []*companyState
}
type newsItemV4 struct {
	ID       string   `json:"id"`
	Time     int64    `json:"time"`
	Headline string   `json:"headline"`
	Body     string   `json:"body"`
	Scope    string   `json:"scope"`
	Symbols  []string `json:"symbols"`
	Impact   string   `json:"impact"`
	Kind     string   `json:"kind,omitempty"`
	ReportID string   `json:"reportId,omitempty"`
}

type savedMarketV4 struct {
	SchemaVersion int      `json:"schemaVersion"`
	Data          *stateV4 `json:"data"`
}

func restoreV4(data []byte) (*Engine, error) {
	var old savedMarketV4
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&old); err != nil {
		return nil, err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return nil, errors.New("旧存档含尾随数据")
	}
	if old.SchemaVersion != 4 || old.Data == nil {
		return nil, errors.New("旧存档格式错误")
	}
	if err := requireJSONFields(data, reflect.TypeOf(old)); err != nil {
		return nil, err
	}
	for _, n := range old.Data.News {
		if n.Kind != "" && n.Kind != "earnings" {
			return nil, errors.New("旧存档含不兼容新闻")
		}
	}
	raw, err := json.Marshal(old.Data)
	if err != nil {
		return nil, err
	}
	var s state
	if err = json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	e := &Engine{s: &s}
	if err = e.validateCore(); err != nil {
		return nil, err
	}
	s.Events, err = newEventState(Options{}, &s)
	if err != nil {
		return nil, err
	}
	e.scheduleEvents()
	if err = e.validateEvents(); err != nil {
		return nil, err
	}
	return e, nil
}
func sameEventPlan(a, b externalEventPlan) bool { return reflect.DeepEqual(a, b) }
func eventDateAndSeconds(at int64) (string, int64) {
	d := time.UnixMilli(at).In(china)
	return d.Format("2006-01-02"), int64(d.Hour()*3600 + d.Minute()*60 + d.Second())
}
func validPublication(at int64) bool {
	date, sec := eventDateAndSeconds(at)
	return validDate(date) && at%30000 == 0 && ((sec > openSeconds && sec <= noonSeconds) || (sec > afternoonSeconds && sec <= closeSeconds))
}

// Count weekdays in constant time even for adversarial distant dates.
func tradingDaysBetween(from, to string) int64 {
	a, _ := time.Parse("2006-01-02", from)
	b, _ := time.Parse("2006-01-02", to)
	days := b.Unix()/86400 - a.Unix()/86400
	if days < 0 {
		return -tradingDaysBetween(to, from)
	}
	n := days / 7 * 5
	for i := int64(1); i <= days%7; i++ {
		wd := (int(a.Weekday()) + int(i)) % 7
		if wd != 0 && wd != 6 {
			n++
		}
	}
	return n
}
func (e *Engine) validateEventPlan(p externalEventPlan) error {
	fail := func() error { return errors.New("外部事件计划或公告参数校验失败") }
	if !validPublication(p.Time) || p.Tick < 0 || p.DayIndex < 0 || !finite(p.Shock) || p.Impact != "positive" && p.Impact != "negative" || p.Shock == 0 || (p.Shock > 0) != (p.Impact == "positive") {
		return fail()
	}
	magnitude := math.Abs(p.Shock)
	if p.Severity == "major" {
		if magnitude < .12 || magnitude > .22 {
			return fail()
		}
	} else if p.Severity == "extreme" {
		if magnitude < .22 || magnitude > .35 {
			return fail()
		}
	} else {
		return fail()
	}
	if p.Category != "policy" && p.Category != "disaster" && p.Category != "supply-chain" && p.Category != "technology" || p.Category == "disaster" && p.Impact != "negative" || p.Category == "technology" && p.Impact != "positive" {
		return fail()
	}
	if len(p.Symbols) == 0 {
		return fail()
	}
	source := e.findStock(p.Symbols[0])
	if source == nil {
		return fail()
	}
	expected := []string{}
	for _, q := range e.s.Stocks {
		if p.Scope == "market" || p.Scope == "sector" && q.Sector == source.Sector || p.Scope == "company" && q.Symbol == source.Symbol {
			expected = append(expected, q.Symbol)
		}
	}
	if !reflect.DeepEqual(expected, p.Symbols) {
		return fail()
	}
	return nil
}
func (e *Engine) validateEvents() error {
	s := e.s
	v := s.Events
	fail := func() error { return errors.New("私有外部事件状态、计划或公告校验失败") }
	if v == nil || v.ModelVersion != 1 || v.MeanDays <= eventCooldownDays || v.MeanDays > 1000000 || v.Counter < 0 || v.StartAt < 0 || v.StartTick < 0 || v.StartTick > s.Tick || v.StartDay < 0 || v.StartDay > s.DayIndex || v.ScheduledDay != s.DayIndex || v.Plans == nil || len(v.Plans) > 1 || v.Records == nil || len(v.Records) > 100 {
		return fail()
	}
	key, err := hex.DecodeString(v.Key)
	if err != nil || len(key) != 32 || hex.EncodeToString(key) != v.Key {
		return fail()
	}
	startDate, startSeconds := eventDateAndSeconds(v.StartAt)
	if !validDate(startDate) || v.StartAt > timestamp(s.Date, s.Seconds) || v.StartAt%30000 != 0 || !((startSeconds >= openSeconds && startSeconds <= noonSeconds) || (startSeconds >= afternoonSeconds && startSeconds <= closeSeconds)) || tradingDaysBetween(startDate, s.Date) != s.DayIndex-v.StartDay || s.Tick-v.StartTick != (s.DayIndex-v.StartDay)*480+tradingOrdinal(s.Seconds)-tradingOrdinal(startSeconds) {
		return fail()
	}
	if v.Disabled && (v.Counter != 0 || len(v.Plans) > 0 || len(v.Records) > 0) {
		return fail()
	}
	records := map[string]externalEventRecord{}
	var previous *externalEventRecord
	for i := range v.Records {
		r := &v.Records[i]
		if err := e.validateEventPlan(r.externalEventPlan); err != nil {
			return err
		}
		date, sec := eventDateAndSeconds(r.Time)
		if r.ID != fmt.Sprintf("N%d", r.Seq) || r.Seq <= 0 || r.Seq > s.Seq || r.Time < v.StartAt || r.Time > timestamp(s.Date, s.Seconds) || r.DayIndex < v.StartDay || r.DayIndex > s.DayIndex || tradingDaysBetween(startDate, date) != r.DayIndex-v.StartDay || r.Tick-v.StartTick != (r.DayIndex-v.StartDay)*480+tradingOrdinal(sec)-tradingOrdinal(startSeconds) {
			return fail()
		}
		if _, ok := records[r.ID]; ok {
			return fail()
		}
		if previous != nil && (r.Seq >= previous.Seq || r.Time >= previous.Time || previous.DayIndex-r.DayIndex <= eventCooldownDays) {
			return fail()
		}
		records[r.ID] = *r
		previous = r
	}
	if len(v.Plans) > 0 {
		p := v.Plans[0]
		if err := e.validateEventPlan(p); err != nil {
			return err
		}
		date, sec := eventDateAndSeconds(p.Time)
		if p.DayIndex != s.DayIndex || date != s.Date || p.Time <= timestamp(s.Date, s.Seconds) || p.Tick-s.Tick != tradingOrdinal(sec)-tradingOrdinal(s.Seconds) || len(v.Records) > 0 && s.DayIndex <= v.Records[0].DayIndex+eventCooldownDays {
			return fail()
		}
	}
	seen := map[string]bool{}
	for _, n := range s.News {
		if n.Kind != "external" {
			if n.Event != nil {
				return fail()
			}
			continue
		}
		r, ok := records[n.ID]
		if !ok || seen[n.ID] || !reflect.DeepEqual(n, e.externalEventNews(r)) {
			return fail()
		}
		seen[n.ID] = true
	}
	// Records can outlive the 100-news window, but a still-retained announcement
	// cannot silently vanish while its private trading response remains active.
	for _, r := range v.Records {
		required := len(s.News) < 100
		if !required {
			oldest := s.News[len(s.News)-1]
			seq, err := strconv.ParseInt(strings.TrimPrefix(oldest.ID, "N"), 10, 64)
			if err == nil && strings.HasPrefix(oldest.ID, "N") {
				required = r.Seq >= seq
			} else {
				required = r.Time >= oldest.Time
			}
		}
		if required && !seen[r.ID] {
			return fail()
		}
	}
	return nil
}
