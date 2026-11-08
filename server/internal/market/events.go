package market

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
)

const defaultEventMeanDays int64 = 100
const eventCooldownDays int64 = 3
const eventHalfLifeTicks int64 = 240
const eventDurationTicks int64 = 1440

type externalEventPlan struct {
	Time, Tick, DayIndex              int64
	Category, Severity, Scope, Impact string
	Symbols                           []string
	Shock                             float64
}
type externalEventRecord struct {
	externalEventPlan
	ID  string
	Seq int64
}
type eventState struct {
	ModelVersion                               int64
	Key                                        string
	Counter, MeanDays                          int64
	Disabled                                   bool
	StartAt, StartTick, StartDay, ScheduledDay int64
	Plans                                      []externalEventPlan
	Records                                    []externalEventRecord
}

func newEventState(options Options, s *state) (*eventState, error) {
	mean := options.EventMeanDays
	if mean == 0 {
		mean = defaultEventMeanDays
	}
	if mean <= eventCooldownDays || mean > 1000000 {
		return nil, errors.New("事件平均间隔必须为4至1000000个交易日")
	}
	var key [32]byte
	if options.EventSeed != "" {
		key = sha256.Sum256([]byte("stocksim:external:v1:" + options.EventSeed))
	} else if _, err := rand.Read(key[:]); err != nil {
		return nil, fmt.Errorf("无法初始化私有事件随机流: %w", err)
	}
	return &eventState{ModelVersion: 1, Key: hex.EncodeToString(key[:]), MeanDays: mean, Disabled: options.DisableEvents, StartAt: timestamp(s.Date, s.Seconds), StartTick: s.Tick, StartDay: s.DayIndex, ScheduledDay: s.DayIndex - 1, Plans: []externalEventPlan{}, Records: []externalEventRecord{}}, nil
}
func (v *eventState) random() float64 {
	key, _ := hex.DecodeString(v.Key)
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(v.Counter))
	v.Counter++
	h := hmac.New(sha256.New, key)
	h.Write(counter[:])
	sum := h.Sum(nil)
	return float64(binary.BigEndian.Uint64(sum[:8])>>11) / 9007199254740992
}
func tradingOrdinal(seconds int64) int64 {
	if seconds <= noonSeconds {
		return clampInt((seconds-openSeconds)/30, 0, 240)
	}
	if seconds <= afternoonSeconds {
		return 240
	}
	return clampInt(240+(seconds-afternoonSeconds)/30, 240, 480)
}
func publicationSeconds(ordinal int64) int64 {
	if ordinal <= 240 {
		return openSeconds + ordinal*30
	}
	return afternoonSeconds + (ordinal-240)*30
}
func (e *Engine) scheduleEvents() {
	s := e.s
	v := s.Events
	if v == nil || v.ScheduledDay == s.DayIndex {
		return
	}
	v.ScheduledDay = s.DayIndex
	v.Plans = []externalEventPlan{}
	remaining := 480 - tradingOrdinal(s.Seconds)
	if v.Disabled || remaining <= 0 || len(v.Records) > 0 && s.DayIndex <= v.Records[0].DayIndex+eventCooldownDays {
		return
	}
	probability := float64(remaining) / 480 / float64(v.MeanDays-eventCooldownDays)
	if v.random() >= probability {
		return
	}
	ordinal := tradingOrdinal(s.Seconds) + 1 + int64(v.random()*float64(remaining))
	p := externalEventPlan{Time: timestamp(s.Date, publicationSeconds(ordinal)), Tick: s.Tick + ordinal - tradingOrdinal(s.Seconds), DayIndex: s.DayIndex, Impact: "positive", Severity: "major"}
	if v.random() < .5 {
		p.Impact = "negative"
	}
	categories := []string{"policy", "technology", "supply-chain"}
	if p.Impact == "negative" {
		categories = []string{"policy", "disaster", "supply-chain"}
	}
	p.Category = categories[int(v.random()*3)]
	scope := v.random()
	p.Scope = "company"
	if scope < .15 {
		p.Scope = "market"
	} else if scope < .60 {
		p.Scope = "sector"
	}
	source := s.Stocks[int(v.random()*float64(len(s.Stocks)))]
	p.Symbols = []string{}
	for _, q := range s.Stocks {
		if p.Scope == "market" || p.Scope == "sector" && q.Sector == source.Sector || p.Scope == "company" && q.Symbol == source.Symbol {
			p.Symbols = append(p.Symbols, q.Symbol)
		}
	}
	if v.random() < .2 {
		p.Severity = "extreme"
		p.Shock = .22 + v.random()*.13
	} else {
		p.Shock = .12 + v.random()*.10
	}
	if p.Impact == "negative" {
		p.Shock = -p.Shock
	}
	v.Plans = append(v.Plans, p)
}
func (e *Engine) advanceEvents() {
	v := e.s.Events
	if v == nil || v.Disabled || len(v.Plans) == 0 {
		return
	}
	p := v.Plans[0]
	if p.Time == timestamp(e.s.Date, e.s.Seconds) && p.Tick == e.s.Tick {
		_ = e.publishExternalEvent(p)
	}
}
func (e *Engine) publishExternalEvent(p externalEventPlan) error {
	s := e.s
	v := s.Events
	if v == nil || v.Disabled || p.Time != timestamp(s.Date, s.Seconds) || p.Tick != s.Tick || p.DayIndex != s.DayIndex || len(v.Plans) != 1 || !sameEventPlan(p, v.Plans[0]) || len(v.Records) > 0 && p.DayIndex <= v.Records[0].DayIndex+eventCooldownDays {
		return errors.New("事件未到公告时点或已发布")
	}
	if err := e.validateEventPlan(p); err != nil {
		return err
	}
	s.Seq++
	record := externalEventRecord{externalEventPlan: p, ID: fmt.Sprintf("N%d", s.Seq), Seq: s.Seq}
	v.Records = append([]externalEventRecord{record}, v.Records...)
	if len(v.Records) > 100 {
		v.Records = v.Records[:100]
	}
	v.Plans = []externalEventPlan{}
	e.prependNews(e.externalEventNews(record))
	for _, symbol := range p.Symbols {
		q := e.findStock(symbol)
		if p.Shock > 0 {
			ceiling := float64(q.Last) * 2
			if q.Fundamental < ceiling {
				q.Fundamental = math.Min(ceiling, q.Fundamental*math.Exp(.6*p.Shock))
			}
		} else {
			floor := float64(q.Last) * .5
			if q.Fundamental > floor {
				q.Fundamental = math.Max(floor, q.Fundamental*math.Exp(.6*p.Shock))
			}
		}
		q.Sentiment = clamp(q.Sentiment+.04*p.Shock, -.035, .035)
	}
	return nil
}
func (e *Engine) externalEventNews(r externalEventRecord) NewsItem {
	label := "全市场"
	if r.Scope == "sector" {
		label = e.findStock(r.Symbols[0]).Sector
	} else if r.Scope == "company" {
		label = e.findStock(r.Symbols[0]).Name
	}
	titles := map[string]string{"policy": "重大支持政策公布", "technology": "关键技术取得突破", "supply-chain": "关键供应链恢复"}
	descriptions := map[string]string{"policy": "新的支持政策有望改善经营与融资条件", "technology": "新的技术进展有望改变行业成本与竞争格局", "supply-chain": "关键供应恢复，经营与交付预期改善"}
	if r.Impact == "negative" {
		titles = map[string]string{"policy": "关键政策突然收紧", "disaster": "突发灾害冲击经营", "supply-chain": "关键供应链中断"}
		descriptions = map[string]string{"policy": "新的限制措施增加经营与融资不确定性", "disaster": "突发灾害影响生产、运输与正常经营", "supply-chain": "关键供应中断，生产成本和交付风险上升"}
	}
	severity := "重大"
	if r.Severity == "extreme" {
		severity = "极端"
	}
	return NewsItem{ID: r.ID, Time: r.Time, Headline: label + "：" + titles[r.Category], Body: severity + "外部事件：" + descriptions[r.Category] + "。相关交易者正在重新评估估值、风险与仓位，盘口流动性可能减弱，实际价格仍由买卖委托撮合决定。消息方向不保证随后涨跌，也不保证触及涨跌停。", Scope: r.Scope, Symbols: append([]string{}, r.Symbols...), Impact: r.Impact, Kind: "external", Event: &ExternalEventInfo{Category: r.Category, Severity: r.Severity}}
}
func (e *Engine) eventResponseAt(symbol string, tick int64) (float64, float64) {
	v := e.s.Events
	if v == nil || v.Disabled || len(v.Records) == 0 {
		return 0, 0
	}
	r := v.Records[0]
	age := tick - r.Tick
	if age < 0 || age >= eventDurationTicks {
		return 0, 0
	}
	affected := false
	for _, s := range r.Symbols {
		if s == symbol {
			affected = true
			break
		}
	}
	if !affected {
		return 0, 0
	}
	decay := math.Exp2(-float64(age) / float64(eventHalfLifeTicks))
	return .10 * r.Shock * decay, math.Abs(r.Shock) / .35 * decay
}
