package com.acme;

import java.util.List;

/**
 * Runs things.
 * Twice.
 */
@Deprecated
public class A extends B implements C, Runnable {
    private static final int LIMIT = 3;
    protected String name = compute(), other;
    int packageField;
    private final Repo repo = new Repo();

    public A() {
        this.init();
    }

    /** Runs. */
    @Override
    public void run() {
        helper();
        this.helper();
        repo.save(name);
        Util.f(1);
        List<String> xs = new ArrayList<>();
        new com.acme.Thing().go();
    }

    void over(int a) {}

    void over(String a, List<String> b) {}

    static void helper() {}

    abstract static class Abs {
        abstract void todo();
        protected abstract int value();
    }
}
