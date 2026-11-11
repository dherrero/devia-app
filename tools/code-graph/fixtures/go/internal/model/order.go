package model

type Status int

const (
	Open Status = iota
	Paid
)

type Line struct {
	SKU       string
	Quantity  int
	UnitPrice int64
}

func (l Line) Total() int64 {
	return int64(l.Quantity) * l.UnitPrice
}

type Order struct {
	base
	Owner  *User
	Lines  []Line
	Status Status
}

func NewOrder(id string, owner *User) *Order {
	return &Order{base: base{id: id}, Owner: owner}
}

func (o *Order) AddLine(l Line) {
	o.Lines = append(o.Lines, l)
}

func (o *Order) Total() int64 {
	var sum int64
	for _, l := range o.Lines {
		sum += l.Total()
	}
	return sum
}

func (o *Order) MarkPaid() {
	o.Status = Paid
}

func (o *Order) Key() string {
	return "order:" + o.ID()
}
