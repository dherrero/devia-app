package com.acme;

public class Outer {
    public class Inner {
        void deep() { ping(); }

        class Deeper {
            void bottom() {}
        }
    }

    static class Nested {}

    void work() {
        class Local {
            void hidden() { skipped(); }
        }
        Runnable r = new Runnable() {
            public void run() { fromAnon(); }
        };
        Runnable l = () -> fromLambda();
        int local = 1;
        r.run();
    }
}
