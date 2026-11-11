package core

import "fmt"

// Logger writes scoped log lines.
type Logger struct {
	scope string
}

func NewLogger(scope string) *Logger {
	return &Logger{scope: scope}
}

func (l *Logger) Info(msg string) {
	l.write("INFO", msg)
}

func (l *Logger) Warn(msg string) {
	l.write("WARN", msg)
}

func (l *Logger) Child(name string) *Logger {
	return NewLogger(l.scope + ":" + name)
}

func (l *Logger) write(level, msg string) {
	fmt.Println(FormatLine(l.scope, level+" "+msg))
}
