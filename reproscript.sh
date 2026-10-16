set -e

docker exec wordpress-app mkdir -p /var/www/html/wp-content/mu-plugins

docker exec -i wordpress-app tee /var/www/html/wp-content/mu-plugins/allow-local-webhooks.php >/dev/null <<'EOF'
<?php
add_filter( "http_request_host_is_external", "__return_true" );
add_filter( "http_request_safe_ports", function($ports) {



	$ports[] = 3000;
	return $ports;
});



add_filter( "http_request_args", function($args) {


	$args["reject_unsafe_urls"] = false;
	return $args;
});
EOF

docker exec -u root wordpress-app chown -R www-data:www-data /var/www/html/wp-content/uploads

for i in {1..8}; do
	wp wc shop_order create --status=processing --billing='{"email":"testmail@mail.com", "first_name":"first", "last_name":"last"}' --user=1 >/dev/null

	wp action-scheduler run >/dev/null
	wp db query "SELECT webhook_id, status, failure_count FROM wp_wc_webhooks WHERE webhook_id = 1;"

done
