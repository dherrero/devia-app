package com.acme.shop.service;

import com.acme.shop.core.Logger;
import com.acme.shop.model.User;
import static com.acme.shop.util.Strings.slugify;

public class UserService {
    private final Repository<User> repo = new InMemoryRepository<>();
    private final Logger log;

    public UserService(Logger log) {
        this.log = log;
    }

    public User register(String name, String email) {
        User user = new User(slugify(name), name, email);
        repo.save(user);
        log.info("registered " + user.getId());
        return user;
    }

    public User find(String id) {
        return repo.get(id);
    }
}
