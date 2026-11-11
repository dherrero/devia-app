package core

type Handler func(payload string)

type Bus struct {
	handlers []Handler
}

func (b *Bus) Subscribe(h Handler) {
	b.handlers = append(b.handlers, h)
}

func (b *Bus) Publish(payload string) {
	for _, h := range b.handlers {
		h(payload)
	}
}

func (b Bus) Count() int {
	return len(b.handlers)
}
