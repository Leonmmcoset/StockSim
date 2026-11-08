package market

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

func New(options Options) (*Engine, error) {
	seed := options.Seed
	if seed == "" {
		seed = DefaultSeed
	}
	if len(seed) > 1200 {
		return nil, errors.New("种子过长")
	}
	days := 60
	if options.HistoryDays != nil {
		days = *options.HistoryDays
	}
	if days < 0 || days > 250 {
		return nil, errors.New("背景天数须为0至250")
	}
	s := &state{Seed: seed, RNG: hashSeed(seed), Date: "2026-11-09", Seconds: openSeconds, Wallets: []*wallet{}, Stocks: []*stock{}, Orders: map[string]*internalOrder{}, Players: map[string]*player{}, PlayerIDs: []string{}, News: []NewsItem{}, SectorFactors: map[string]float64{}, TotalShares: map[string]int64{}}
	e := &Engine{s: s}
	for _, u := range universe {
		s.SectorFactors[u.Sector] = 0
		q := &stock{Symbol: u.Symbol, Name: u.Name, Sector: u.Sector, Base: u.Price, Beta: u.Beta, Fundamental: float64(u.Price), EMA: float64(u.Price), Variance: 1e-7, Last: u.Price, PrevClose: u.Price, Open: u.Price, High: u.Price, Low: u.Price, Bids: []string{}, Asks: []string{}, Agents: []int{}, MinuteBars: []Bar{}, DailyBars: []Bar{}, Tape: []TapeTrade{}}
		limits(q)
		s.Stocks = append(s.Stocks, q)
	}
	e.history(days)
	for _, q := range s.Stocks {
		for i := 0; i < 48; i++ {
			kind := "noise"
			if i < 16 {
				kind = "liquidity"
			} else if i < 28 {
				kind = "fundamental"
			} else if i < 40 {
				kind = "trend"
			}
			cash := 100000 * q.Last
			w := newWallet(kind, cash, normal(&s.RNG)*.15)
			w.Positions[q.Symbol] = &holdingState{Quantity: 100000, CostBasis: cash}
			q.Agents = append(q.Agents, len(s.Wallets))
			s.Wallets = append(s.Wallets, w)
			s.TotalCash += cash
		}
		s.TotalShares[q.Symbol] = 4800000
		e.newDaily(q)
		e.seedLiquidity(q)
	}
	e.initializeCompanies()
	s.News = append(s.News, NewsItem{ID: "welcome", Time: timestamp(s.Date, openSeconds), Headline: "股海模拟市场开市", Body: "12家虚构公司已进入竞价交易。每位玩家初始资金5000元，买入100股起，T+1可卖；背景历史为合成行情。", Scope: "market", Symbols: []string{}, Impact: "neutral"})
	e.Step(10)
	var err error
	s.Events, err = newEventState(options, s)
	if err != nil {
		return nil, err
	}
	e.scheduleEvents()
	return e, nil
}
func (e *Engine) AddPlayer(id string) error {
	if strings.TrimSpace(id) == "" || len(id) > 200 {
		return errors.New("玩家标识无效")
	}
	s := e.s
	if _, ok := s.Players[id]; ok {
		return errors.New("玩家已存在")
	}
	w := newWallet("player", initialCash, 0)
	w.PlayerID = id
	p := &player{ID: id, Owner: len(s.Wallets), InitialCash: initialCash, OrderIDs: []string{}, Trades: []PlayerTrade{}}
	s.Wallets = append(s.Wallets, w)
	s.Players[id] = p
	s.PlayerIDs = append(s.PlayerIDs, id)
	s.TotalCash += initialCash
	e.initializeReview(p)
	return nil
}
func (e *Engine) PlayerIDs() []string { return append([]string{}, e.s.PlayerIDs...) }
func (e *Engine) Clock() MarketClock {
	s := e.s
	ph := phase(s)
	labels := map[string]string{"continuous": "连续竞价", "lunch": "午间休市", "closing-auction": "收盘集合竞价", "closed": "已收盘"}
	return MarketClock{DayIndex: s.DayIndex, Date: s.Date, Time: fmt.Sprintf("%02d:%02d:%02d", s.Seconds/3600, s.Seconds%3600/60, s.Seconds%60), Timestamp: timestamp(s.Date, s.Seconds), Phase: ph, PhaseLabel: labels[ph]}
}
func (e *Engine) history(days int) {
	s := e.s
	date := shiftDate(s.Date, -days)
	volatility := .013
	for day := 0; day < days; day++ {
		volatility = clamp(.91*volatility+.09*(.009+math.Abs(normal(&s.RNG))*.012), .008, .035)
		market := normal(&s.RNG) * volatility * .42
		sf := map[string]float64{}
		for _, sector := range sectors {
			sf[sector] = normal(&s.RNG) * volatility * .45
		}
		for _, q := range s.Stocks {
			prev := float64(q.Last)
			ret := clamp(market*q.Beta+sf[q.Sector]+normal(&s.RNG)*volatility*.62, -.095, .095)
			close := max(int64(50), round(prev*math.Exp(ret)))
			lo, hi := round(prev*.9), round(prev*1.1)
			open := clampInt(round(prev*math.Exp(normal(&s.RNG)*.003)), lo, hi)
			high := clampInt(round(float64(max(open, close))*(1+math.Abs(normal(&s.RNG))*.007)), lo, hi)
			low := clampInt(round(float64(min(open, close))*(1-math.Abs(normal(&s.RNG))*.007)), lo, hi)
			volume := round((1500+random(&s.RNG)*3500)*(1+math.Abs(ret)*25)) * 100
			q.DailyBars = append(q.DailyBars, Bar{Time: timestamp(date, openSeconds), Open: open, High: high, Low: low, Close: clampInt(close, lo, hi), Volume: volume, Turnover: volume * round(float64(open+high+low+close)/4)})
			q.Last = clampInt(close, lo, hi)
		}
		date = shiftDate(date, 1)
	}
	for _, q := range s.Stocks {
		q.PrevClose = q.Last
		q.Open = q.Last
		q.High = q.Last
		q.Low = q.Last
		q.Fundamental = float64(q.Last)
		q.EMA = float64(q.Last)
		limits(q)
	}
}
func (e *Engine) newDaily(q *stock) {
	q.DailyBars = append(q.DailyBars, emptyBar(timestamp(e.s.Date, openSeconds), q.Last))
	if len(q.DailyBars) > 251 {
		q.DailyBars = q.DailyBars[1:]
	}
}
func (e *Engine) seedLiquidity(q *stock) {
	for i := 0; i < 8; i++ {
		distance := int64(1) + int64(i)*max(1, round(float64(q.Last)*.0007))
		e.submit(q, q.Agents[i], "buy", clampInt(q.Last-distance, q.LimitDown, q.LimitUp), int64(1500+i%3*500), int64(60+i))
		e.submit(q, q.Agents[8+i], "sell", clampInt(q.Last+distance, q.LimitDown, q.LimitUp), int64(1500+i%3*500), int64(60+i))
	}
}
func (e *Engine) book(q *stock, side string) []*internalOrder {
	ids := q.Bids
	if side == "sell" {
		ids = q.Asks
	}
	out := make([]*internalOrder, 0, len(ids))
	for _, id := range ids {
		if o := e.s.Orders[id]; o != nil && active(o) {
			out = append(out, o)
		}
	}
	return out
}
func (e *Engine) sortBook(q *stock, side string) {
	ids := q.Bids
	if side == "sell" {
		ids = q.Asks
	}
	sort.SliceStable(ids, func(i, j int) bool {
		a, b := e.s.Orders[ids[i]], e.s.Orders[ids[j]]
		if a.Price == b.Price {
			return a.Seq < b.Seq
		}
		if side == "buy" {
			return a.Price > b.Price
		}
		return a.Price < b.Price
	})
}
func (e *Engine) remove(q *stock, o *internalOrder) {
	ids := &q.Bids
	if o.Side == "sell" {
		ids = &q.Asks
	}
	for i, id := range *ids {
		if id == o.ID {
			*ids = append((*ids)[:i], (*ids)[i+1:]...)
			break
		}
	}
	if !e.isPlayer(o.Owner) {
		delete(e.s.Orders, o.ID)
	}
}
func (e *Engine) cancelInternal(q *stock, o *internalOrder, status string) {
	if !active(o) {
		return
	}
	w := e.s.Wallets[o.Owner]
	if o.Side == "buy" {
		w.FrozenCash -= o.Reserve
		o.Reserve = 0
	} else {
		holding(w, o.Symbol).Frozen -= o.Remaining
	}
	o.Status = status
	e.remove(q, o)
}
func (e *Engine) cage(q *stock, side string) int64 {
	opposite := "sell"
	if side == "sell" {
		opposite = "buy"
	}
	opp, same := e.book(q, opposite), e.book(q, side)
	base := q.PrevClose
	if q.Volume > 0 {
		base = q.Last
	}
	if len(opp) > 0 {
		base = opp[0].Price
	} else if len(same) > 0 {
		base = same[0].Price
	}
	if side == "buy" {
		return round(math.Max(float64(base)*1.02, float64(base+10)))
	}
	return round(math.Min(float64(base)*.98, float64(base-10)))
}
func (e *Engine) submit(q *stock, owner int, side string, price, quantity, lifetime int64) *internalOrder {
	s := e.s
	w := s.Wallets[owner]
	h := holding(w, q.Symbol)
	price = clampInt(price, q.LimitDown, q.LimitUp)
	if phase(s) == "continuous" {
		if side == "buy" {
			price = min(price, e.cage(q, side))
		} else {
			price = max(price, e.cage(q, side))
		}
	}
	human := e.isPlayer(owner)
	if side == "buy" && !human {
		available := w.Cash - w.FrozenCash
		quantity = min(quantity, max(0, int64(math.Floor(float64(available-501)/(float64(price)*100*1.00026)))*100))
	} else if side == "sell" {
		quantity = min(quantity, h.Quantity-h.TodayBought-h.Frozen)
	}
	if !human || side == "buy" {
		quantity = quantity / 100 * 100
	}
	if quantity <= 0 {
		return nil
	}
	s.Seq++
	id := fmt.Sprintf("O%d", s.Seq)
	expires := s.Tick + lifetime
	if human {
		expires = 9007199254740991
	}
	o := &internalOrder{Order: Order{ID: id, Symbol: q.Symbol, Side: side, Price: price, Quantity: quantity, Remaining: quantity, Status: "open", CreatedAt: timestamp(s.Date, s.Seconds)}, Owner: owner, Seq: s.Seq, Expires: expires}
	s.Orders[id] = o
	if human {
		s.Players[w.PlayerID].OrderIDs = append(s.Players[w.PlayerID].OrderIDs, id)
	}
	if side == "buy" {
		e.updateReserve(o)
	} else {
		h.Frozen += quantity
	}
	if phase(s) == "continuous" {
		e.match(q, o)
	}
	if o.Remaining > 0 {
		if side == "buy" {
			q.Bids = append(q.Bids, id)
		} else {
			q.Asks = append(q.Asks, id)
		}
		e.sortBook(q, side)
	} else if !human {
		delete(s.Orders, id)
	}
	return o
}
func (e *Engine) match(q *stock, incoming *internalOrder) {
	ids := &q.Asks
	if incoming.Side == "sell" {
		ids = &q.Bids
	}
	for incoming.Remaining > 0 && len(*ids) > 0 {
		resting := e.s.Orders[(*ids)[0]]
		if incoming.Side == "buy" && resting.Price > incoming.Price || incoming.Side == "sell" && resting.Price < incoming.Price {
			break
		}
		if resting.Owner == incoming.Owner {
			e.cancelInternal(q, resting, "cancelled")
			continue
		}
		e.fill(q, incoming, resting, resting.Price, min(incoming.Remaining, resting.Remaining), incoming.Side)
		if resting.Remaining == 0 {
			e.remove(q, resting)
		}
	}
}
func (e *Engine) fill(q *stock, a, b *internalOrder, price, quantity int64, side string) {
	s := e.s
	at := timestamp(s.Date, s.Seconds)
	s.Seq++
	id := fmt.Sprintf("T%d", s.Seq)
	for _, o := range []*internalOrder{a, b} {
		fee := e.settle(o, price, quantity)
		if e.isPlayer(o.Owner) {
			p := s.Players[s.Wallets[o.Owner].PlayerID]
			t := PlayerTrade{ID: id + "-" + o.ID, OrderID: o.ID, Symbol: q.Symbol, Side: o.Side, Time: at, Price: price, Quantity: quantity, Amount: price * quantity, Fee: fee}
			p.Trades = append([]PlayerTrade{t}, p.Trades...)
			if len(p.Trades) > 5000 {
				p.Trades = p.Trades[:5000]
			}
		}
	}
	if q.Volume == 0 {
		q.Open = price
		q.High = price
		q.Low = price
	}
	q.Last = price
	q.High = max(q.High, price)
	q.Low = min(q.Low, price)
	q.Volume += quantity
	q.Turnover += price * quantity
	q.Tape = append([]TapeTrade{{ID: id, Symbol: q.Symbol, Time: at, Price: price, Quantity: quantity, Side: side}}, q.Tape...)
	if len(q.Tape) > 100 {
		q.Tape = q.Tape[:100]
	}
	minute := at / 60000 * 60000
	if len(q.MinuteBars) == 0 || q.MinuteBars[len(q.MinuteBars)-1].Time != minute {
		q.MinuteBars = append(q.MinuteBars, emptyBar(minute, price))
	}
	bar := &q.MinuteBars[len(q.MinuteBars)-1]
	if bar.Volume == 0 {
		bar.Open = price
		bar.High = price
		bar.Low = price
	} else {
		bar.High = max(bar.High, price)
		bar.Low = min(bar.Low, price)
	}
	bar.Close = price
	bar.Volume += quantity
	bar.Turnover += price * quantity
	daily := &q.DailyBars[len(q.DailyBars)-1]
	daily.Open = q.Open
	daily.High = q.High
	daily.Low = q.Low
	daily.Close = price
	daily.Volume = q.Volume
	daily.Turnover = q.Turnover
	for _, o := range []*internalOrder{a, b} {
		if e.isPlayer(o.Owner) {
			e.recordReview(s.Players[s.Wallets[o.Owner].PlayerID], o.Side, price*quantity, false)
		}
	}
}
func (e *Engine) agentAction(q *stock, owner int) {
	s := e.s
	w := s.Wallets[owner]
	h := holding(w, q.Symbol)
	p := float64(q.Last)
	if phase(s) == "continuous" {
		for _, o := range append(e.book(q, "buy"), e.book(q, "sell")...) {
			if o.Owner == owner {
				e.cancelInternal(q, o, "cancelled")
			}
		}
	}
	inv := float64(h.Quantity) * p / math.Max(1, float64(w.Cash)+float64(h.Quantity)*p)
	eventSignal, eventRisk := e.eventResponseAt(q.Symbol, s.Tick)
	risk := math.Sqrt(q.Variance)
	fund := math.Log(q.Fundamental / p)
	trend := clamp(math.Log(p/q.EMA), -.015, .015)
	if w.Kind == "liquidity" {
		shift := clamp((q.Fundamental*math.Exp(q.Sentiment)-p)*.12-(inv-.5)*p*.008, -p*.003, p*.003)
		if eventRisk > 0 {
			shift = clamp(shift+p*eventSignal*.18, -p*.008, p*.008)
		}
		center := p + shift
		spread := max(int64(1), round(p*(.0005+risk*.5)))
		size := (4 + int64(math.Floor(random(&s.RNG)*12))) * 100
		if eventRisk > 0 {
			spread = max(1, round(float64(spread)*(1+1.5*eventRisk)))
			size = max(100, int64(math.Floor(float64(size)*(1-.5*eventRisk)/100))*100)
		}
		e.submit(q, owner, "buy", round(center-float64(spread)), size, 10+int64(math.Floor(random(&s.RNG)*12)))
		e.submit(q, owner, "sell", round(center+float64(spread)), size, 10+int64(math.Floor(random(&s.RNG)*12)))
		return
	}
	wf, wt, ws := .035, .05, 1.
	if w.Kind == "fundamental" {
		wf = .24
	}
	if w.Kind == "trend" {
		wt = .85
	}
	if w.Kind == "noise" {
		ws = .5
	}
	signal := wf*fund + wt*trend + q.Sentiment*ws + normal(&s.RNG)*(.0012+risk+.0012*eventRisk) + w.Bias*.001
	if eventRisk > 0 {
		weight := 1.
		if w.Kind == "fundamental" {
			weight = .8
		} else if w.Kind == "trend" {
			weight = .6
		}
		signal += eventSignal * weight * clamp(1+w.Bias*.35, .5, 1.5)
	}
	buyProb := clamp(.5+signal*55-(inv-.5)*.55, .06, .94)
	side, opposite := "sell", "buy"
	if random(&s.RNG) < buyProb {
		side, opposite = "buy", "sell"
	}
	conviction := math.Abs(signal)
	aggressive := random(&s.RNG) < clamp(.38+conviction*50, .3, .85)
	opp := e.book(q, opposite)
	direction := int64(-1)
	if side == "buy" {
		direction = 1
	}
	var price int64
	if aggressive && len(opp) > 0 {
		cross := opp[0].Price + direction*int64(math.Floor(random(&s.RNG)*math.Max(2, p*.0015)))
		reservation := round(p*math.Exp(clamp(signal, -.012, .012)) + float64(direction)*math.Max(2, p*.0015))
		if side == "buy" {
			price = min(cross, reservation)
		} else {
			price = max(cross, reservation)
		}
	} else {
		price = round(p*math.Exp(clamp(signal, -.007, .007)) - float64(direction)*(1+math.Floor(random(&s.RNG)*4)))
	}
	size := (2 + int64(math.Floor(random(&s.RNG)*12+math.Min(10, conviction*500)))) * 100
	e.submit(q, owner, side, price, size, 4+int64(math.Floor(random(&s.RNG)*18)))
}
func (e *Engine) emitNews() {
	s := e.s
	r := random(&s.RNG)
	scope := "company"
	if r < .18 {
		scope = "market"
	} else if r < .48 {
		scope = "sector"
	}
	source := s.Stocks[int(random(&s.RNG)*float64(len(s.Stocks)))]
	positive := random(&s.RNG) > .48
	magnitude := .006 + random(&s.RNG)*.016
	if !positive {
		magnitude = -magnitude
	}
	symbols := []string{}
	for _, q := range s.Stocks {
		if scope == "market" || scope == "sector" && q.Sector == source.Sector || scope == "company" && q.Symbol == source.Symbol {
			q.Fundamental *= math.Exp(magnitude * .55)
			q.Sentiment += magnitude * .28
			symbols = append(symbols, q.Symbol)
		}
	}
	label := source.Name
	if scope == "market" {
		label = "市场"
	} else if scope == "sector" {
		label = source.Sector
	}
	titles := []string{"成本压力增加", "需求预期下修", "短期不确定性上升"}
	impact, body := "negative", "面临新的经营压力"
	if positive {
		titles = []string{"需求改善预期升温", "新订单增长超出预期", "投资信心回升"}
		impact = "positive"
		body = "经营预期出现积极变化"
	}
	s.Seq++
	n := NewsItem{ID: fmt.Sprintf("N%d", s.Seq), Time: timestamp(s.Date, s.Seconds), Headline: label + "：" + titles[int(random(&s.RNG)*float64(len(titles)))], Body: "模拟快讯：" + label + body + "。不同交易者正在重新评估估值和仓位，短期价格仍取决于买卖力量。", Scope: scope, Symbols: symbols, Impact: impact}
	e.prependNews(n)
}
func (e *Engine) prependNews(n NewsItem) {
	e.s.News = append([]NewsItem{n}, e.s.News...)
	if len(e.s.News) > 100 {
		e.s.News = e.s.News[:100]
	}
}
func (e *Engine) Step(ticks int) error {
	if ticks < 0 || ticks > 10000 {
		return errors.New("推进步数必须为0至10000的整数")
	}
	s := e.s
	for i := 0; i < ticks; i++ {
		if phase(s) == "lunch" || phase(s) == "closed" {
			break
		}
		s.Tick++
		marketShock := normal(&s.RNG) * .00018
		s.Macro = .992*s.Macro + marketShock
		for _, sector := range sectors {
			s.SectorFactors[sector] = .985*s.SectorFactors[sector] + normal(&s.RNG)*.00018
		}
		if random(&s.RNG) < .009 {
			e.emitNews()
		}
		for _, q := range s.Stocks {
			before := q.Last
			q.Fundamental *= math.Exp(marketShock*q.Beta + normal(&s.RNG)*.00021)
			q.Sentiment = clamp(.986*q.Sentiment+.014*(s.Macro*q.Beta+s.SectorFactors[q.Sector])+normal(&s.RNG)*.00012, -.035, .035)
			if phase(s) == "continuous" {
				for _, o := range append(e.book(q, "buy"), e.book(q, "sell")...) {
					if !e.isPlayer(o.Owner) && o.Expires <= s.Tick {
						e.cancelInternal(q, o, "expired")
					}
				}
			}
			for j := 0; j < 3; j++ {
				e.agentAction(q, q.Agents[int(random(&s.RNG)*16)])
			}
			for j := 0; j < 5; j++ {
				e.agentAction(q, q.Agents[16+int(random(&s.RNG)*32)])
			}
			ret := math.Log(float64(q.Last) / float64(before))
			q.Variance = .97*q.Variance + .03*ret*ret
			q.EMA = .97*q.EMA + .03*float64(q.Last)
			if phase(s) == "continuous" {
				at := timestamp(s.Date, s.Seconds) / 60000 * 60000
				if len(q.MinuteBars) == 0 || q.MinuteBars[len(q.MinuteBars)-1].Time != at {
					q.MinuteBars = append(q.MinuteBars, emptyBar(at, q.Last))
				}
			}
		}
		s.Seconds += 30
		e.releaseDueEarnings()
		if s.Seconds == closeSeconds {
			e.closeDay()
		}
		e.advanceEvents()
		e.recordAll(s.Seconds == closeSeconds)
	}
	return nil
}
func (e *Engine) closeDay() {
	for _, q := range e.s.Stocks {
		p, ok := clearingPrice(append(e.book(q, "buy"), e.book(q, "sell")...))
		if ok {
			for len(q.Bids) > 0 && len(q.Asks) > 0 {
				b, a := e.s.Orders[q.Bids[0]], e.s.Orders[q.Asks[0]]
				if b.Price < p || a.Price > p {
					break
				}
				if b.Owner == a.Owner {
					if b.Seq > a.Seq {
						e.cancelInternal(q, b, "cancelled")
					} else {
						e.cancelInternal(q, a, "cancelled")
					}
					continue
				}
				e.fill(q, b, a, p, min(b.Remaining, a.Remaining), "buy")
				if b.Remaining == 0 {
					e.remove(q, b)
				}
				if a.Remaining == 0 {
					e.remove(q, a)
				}
			}
		} else if q.Volume > 0 {
			last := q.Tape[0]
			var amount, quantity int64
			for _, t := range q.Tape {
				if t.Time >= last.Time-60000 {
					amount += t.Price * t.Quantity
					quantity += t.Quantity
				}
			}
			q.Last = round(float64(amount) / float64(quantity))
			q.DailyBars[len(q.DailyBars)-1].Close = q.Last
		}
		for _, o := range append(e.book(q, "buy"), e.book(q, "sell")...) {
			e.cancelInternal(q, o, "expired")
		}
	}
}
func (e *Engine) SkipLunch() {
	if phase(e.s) == "lunch" {
		e.s.Seconds = afternoonSeconds
		e.recordAll(false)
	}
}
func (e *Engine) NextDay() {
	s := e.s
	e.Step(1000)
	e.SkipLunch()
	e.Step(1000)
	s.Date = shiftDate(s.Date, 1)
	s.DayIndex++
	s.Seconds = openSeconds
	for _, id := range s.PlayerIDs {
		e.openReviewDay(s.Players[id])
	}
	for _, w := range s.Wallets {
		for _, h := range w.Positions {
			h.TodayBought = 0
		}
	}
	macro := normal(&s.RNG) * .004
	for _, q := range s.Stocks {
		q.PrevClose = q.Last
		q.Open = q.Last
		q.High = q.Last
		q.Low = q.Last
		q.Volume = 0
		q.Turnover = 0
		q.MinuteBars = []Bar{}
		q.Tape = []TapeTrade{}
		limits(q)
		q.Fundamental *= math.Exp(macro*q.Beta + normal(&s.RNG)*.004)
		q.Sentiment *= .65
		e.newDaily(q)
		e.seedLiquidity(q)
	}
	s.Seq++
	e.prependNews(NewsItem{ID: fmt.Sprintf("N%d", s.Seq), Time: timestamp(s.Date, openSeconds), Headline: s.Date + " 新交易日开市", Body: "昨日买入持仓已转为可卖，未成交的昨日委托已失效。", Scope: "market", Symbols: []string{}, Impact: "neutral"})
	e.recordAll(false)
	e.scheduleEvents()
}
func commandError(code, message string) CommandResult {
	return CommandResult{OK: false, Code: code, Error: message}
}
func (e *Engine) PlaceOrder(id string, input OrderInput) CommandResult {
	s := e.s
	p := s.Players[id]
	if p == nil {
		return commandError("PLAYER_NOT_FOUND", "玩家不存在")
	}
	q := e.findStock(input.Symbol)
	if q == nil {
		return commandError("UNKNOWN_SYMBOL", "证券代码不存在")
	}
	if input.Side != "buy" && input.Side != "sell" {
		return commandError("INVALID_QUANTITY", "委托方向无效")
	}
	if input.Price <= 0 || input.Price > 9007199254740991 {
		return commandError("INVALID_PRICE", "委托价格必须精确到0.01元")
	}
	if input.Quantity <= 0 || input.Quantity > 1000000 {
		return commandError("INVALID_QUANTITY", "委托数量须为1至100万股的整数")
	}
	w := s.Wallets[p.Owner]
	h := w.Positions[q.Symbol]
	var sellable int64
	if h != nil {
		sellable = h.Quantity - h.TodayBought - h.Frozen
	}
	if input.Quantity%100 != 0 && (input.Side == "buy" || input.Quantity != sellable) {
		return commandError("INVALID_QUANTITY", "买入须为100股整数倍；零股需一次卖出")
	}
	if phase(s) == "lunch" || phase(s) == "closed" {
		return commandError("MARKET_CLOSED", "当前为休市时段，请等待开市")
	}
	if input.Price < q.LimitDown || input.Price > q.LimitUp {
		return commandError("OUTSIDE_LIMIT", "委托价格超出当日涨跌停范围")
	}
	if phase(s) == "continuous" && (input.Side == "buy" && input.Price > e.cage(q, "buy") || input.Side == "sell" && input.Price < e.cage(q, "sell")) {
		return commandError("PRICE_CAGE", "委托价格超出连续竞价有效申报范围（2%或10个最小价位）")
	}
	if input.Side == "buy" && (input.Price > math.MaxInt64/input.Quantity || input.Price*input.Quantity+fees(input.Price*input.Quantity, "buy").Total > w.Cash-w.FrozenCash) {
		return commandError("INSUFFICIENT_CASH", "可用资金不足，请预留手续费")
	}
	if input.Side == "sell" && input.Quantity > sellable {
		return commandError("INSUFFICIENT_SHARES", "可卖数量不足（当日买入需下一交易日卖出）")
	}
	o := e.submit(q, p.Owner, input.Side, input.Price, input.Quantity, 20)
	if o == nil {
		return commandError("INSUFFICIENT_SHARES", "委托余额不足")
	}
	e.recordAll(false)
	public := o.Order
	return CommandResult{OK: true, Order: &public}
}
func (e *Engine) CancelOrder(id, orderID string) CommandResult {
	p := e.s.Players[id]
	o := e.s.Orders[orderID]
	if p == nil || o == nil || o.Owner != p.Owner {
		return commandError("ORDER_NOT_FOUND", "未找到委托")
	}
	if !active(o) {
		return commandError("ORDER_NOT_OPEN", "该委托已成交、撤销或失效")
	}
	if phase(e.s) == "closing-auction" {
		return commandError("CANCEL_RESTRICTED", "收盘集合竞价14:57至15:00不可撤单")
	}
	e.cancelInternal(e.findStock(o.Symbol), o, "cancelled")
	public := o.Order
	return CommandResult{OK: true, Order: &public}
}
func (e *Engine) PreviewOrder(id string, input OrderInput) (OrderPreview, error) {
	p := e.s.Players[id]
	if p == nil {
		return OrderPreview{}, errors.New("玩家不存在")
	}
	w := e.s.Wallets[p.Owner]
	price, qty := input.Price, input.Quantity
	if price <= 0 || price > 9007199254740991 {
		price = 0
	}
	if qty <= 0 || qty > 1000000 {
		qty = 0
	}
	if price > 0 && qty > 9007199254740991/price {
		qty = 0
	}
	amount := price * qty
	f := fees(amount, input.Side)
	var maximum int64
	if price > 0 {
		maximum = max(0, (w.Cash-w.FrozenCash-500)/price/100*100)
		for maximum > 0 && maximum*price+fees(maximum*price, "buy").Total > w.Cash-w.FrozenCash {
			maximum -= 100
		}
	}
	out := OrderPreview{Amount: amount, Fees: f, MaxBuyQuantity: maximum}
	if input.Side == "buy" {
		out.CashRequired = amount + f.Total
	}
	if h := w.Positions[input.Symbol]; h != nil {
		out.MaxSellQuantity = h.Quantity - h.TodayBought - h.Frozen
	}
	return out, nil
}
func clearingPrice(orders []*internalOrder) (int64, bool) {
	prices := map[int64]bool{}
	lo, hi := int64(math.MaxInt64), int64(0)
	for _, o := range orders {
		if o.Remaining <= 0 {
			continue
		}
		prices[o.Price] = true
		if o.Side == "buy" {
			hi = max(hi, o.Price)
		} else {
			lo = min(lo, o.Price)
		}
	}
	levels := []int64{}
	for p := range prices {
		levels = append(levels, p)
	}
	sort.Slice(levels, func(i, j int) bool { return levels[i] < levels[j] })
	for i := 1; i < len(levels); i++ {
		if levels[i]-levels[i-1] > 1 {
			prices[levels[i-1]+1] = true
			prices[levels[i]-1] = true
		}
	}
	candidates := []int64{}
	for p := range prices {
		candidates = append(candidates, p)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i] < candidates[j] })
	var maximum, first, last int64
	imbalance := int64(math.MaxInt64)
	for _, p := range candidates {
		if p < lo || p > hi {
			continue
		}
		var b, a, sb, sa int64
		for _, o := range orders {
			if o.Side == "buy" && o.Price >= p {
				b += o.Remaining
				if o.Price > p {
					sb += o.Remaining
				}
			}
			if o.Side == "sell" && o.Price <= p {
				a += o.Remaining
				if o.Price < p {
					sa += o.Remaining
				}
			}
		}
		v, gap := min(b, a), b-a
		if gap < 0 {
			gap = -gap
		}
		if v == 0 || sb > v || sa > v {
			continue
		}
		if v > maximum || v == maximum && gap < imbalance {
			maximum = v
			imbalance = gap
			first = p
			last = p
		} else if v == maximum && gap == imbalance {
			last = p
		}
	}
	return (first + last + 1) / 2, maximum > 0
}
