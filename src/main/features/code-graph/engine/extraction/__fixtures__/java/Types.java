package com.acme;

public enum Color implements Named {
    RED, GREEN(2) {
        void x() {}
    };

    private final int n;

    Color() { this(1); }
    Color(int n) { this.n = n; }

    public int code() { return n; }
}

interface Shape extends Named, Comparable<Shape> {
    int SIDES = 4;

    double area();

    default String label() { return "s"; }

    static Shape unit() { return null; }

    private void hidden() {}
}

record Point(int x, int y) implements Named {
    Point {
        check();
    }

    int sum() { return x + y; }
}

@interface Marker {
    String value();
}
