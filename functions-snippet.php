<?php
// Pega esto en functions.php del tema activo (junto al filtro de Application Passwords)

// Habilita Application Passwords (Hostinger las deshabilita por defecto)
add_filter('wp_is_application_passwords_available', '__return_true');

// Expone los campos de Rank Math en la REST API para poder escribirlos desde el pipeline
add_action('init', function () {
    $auth_callback = function () {
        return current_user_can('edit_posts');
    };

    register_meta('post', 'rank_math_title', [
        'object_subtype' => 'page',
        'type' => 'string',
        'single' => true,
        'show_in_rest' => true,
        'auth_callback' => $auth_callback,
    ]);

    register_meta('post', 'rank_math_description', [
        'object_subtype' => 'page',
        'type' => 'string',
        'single' => true,
        'show_in_rest' => true,
        'auth_callback' => $auth_callback,
    ]);
});
