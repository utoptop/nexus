CREATE OR REPLACE FUNCTION qa_reject_node_write() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.node_ip = '198.18.0.250' OR NEW.rx_speed_bps = 7777 THEN RAISE EXCEPTION 'QA simulated node write failure'; END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER qa_node_write BEFORE INSERT OR UPDATE ON api_nodes FOR EACH ROW EXECUTE FUNCTION qa_reject_node_write();
